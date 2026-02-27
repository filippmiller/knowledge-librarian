import { NextRequest, NextResponse } from 'next/server';
import { verifyTelegramWebAppData } from '@/lib/telegram/mini-app-auth';
import { createProcessingToken } from '@/lib/crypto';
import prisma from '@/lib/db';

/**
 * Telegram Mini App API
 * Enhanced with favorites, comments, notifications, offline support
 */

// GET - Load user data, favorites, preferences
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const initData = searchParams.get('initData');

  // Always return public data (rules, domains, stats)
  // Private data (favorites, history) only for authenticated users
  let telegramId: string | null = null;
  let isAdmin = false;
  let userRole = 'USER';
  let userInfo = null;

  // Try to authenticate if initData provided
  if (initData && initData !== 'dev' && initData !== '') {
    const verified = verifyTelegramWebAppData(initData);
    if (verified.valid) {
      telegramId = verified.userId!;
      userInfo = verified.user;
      
      const telegramUser = await prisma.telegramUser.findUnique({
        where: { telegramId },
      });
      
      isAdmin = telegramUser?.role === 'ADMIN' || telegramUser?.role === 'SUPER_ADMIN';
      userRole = telegramUser?.role || 'USER';
    }
  }

  try {
    // Get public data (always available)
    const recentRules = await prisma.rule.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        ruleCode: true,
        title: true,
        confidence: true,
        document: { select: { title: true } },
      },
    });

    const domains = await prisma.domain.findMany({
      orderBy: { title: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        _count: { select: { rules: true } },
      },
    });

    const totalRules = await prisma.rule.count({ where: { status: 'ACTIVE' } });
    const highConfidence = await prisma.rule.count({
      where: { status: 'ACTIVE', confidence: { gte: 0.9 } },
    });
    const mediumConfidence = await prisma.rule.count({
      where: { status: 'ACTIVE', confidence: { gte: 0.7, lt: 0.9 } },
    });
    const lowConfidence = await prisma.rule.count({
      where: { status: 'ACTIVE', confidence: { lt: 0.7 } },
    });

    // Get user-specific data only if authenticated
    let preferences = null;
    let favorites: any[] = [];
    let notifications: any[] = [];
    let unreadCount = 0;
    let subscriptions: any[] = [];
    let history: any[] = [];

    if (telegramId) {
      // Get user preferences
      preferences = await prisma.userPreference.findUnique({
        where: { telegramId },
      });

      if (!preferences) {
        preferences = await prisma.userPreference.create({
          data: { telegramId },
        });
      }

      // Get favorites
      favorites = await prisma.userFavorite.findMany({
        where: { telegramId },
        include: {
          rule: {
            select: {
              id: true,
              ruleCode: true,
              title: true,
              confidence: true,
              document: { select: { title: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Get notifications
      unreadCount = await prisma.notificationLog.count({
        where: { telegramId, isRead: false },
      });

      notifications = await prisma.notificationLog.findMany({
        where: { telegramId },
        orderBy: { sentAt: 'desc' },
        take: 20,
      });

      subscriptions = await prisma.userNotification.findMany({
        where: { telegramId, isActive: true },
      });

      // Get chat history
      const sessions = await prisma.chatSession.findMany({
        where: { source: 'TELEGRAM', userId: telegramId },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 10,
          },
        },
      });

      history = sessions.flatMap(s => s.messages.map(m => ({
        ...m,
        sessionId: s.id,
      })));
    }

    return NextResponse.json({
      user: userInfo,
      isAdmin,
      role: userRole,
      isAuthenticated: !!telegramId,
      preferences,
      favorites,
      notifications: { unreadCount, items: notifications },
      subscriptions,
      history,
      recentRules,
      domains,
      stats: {
        total: totalRules,
        highConfidence,
        mediumConfidence,
        lowConfidence,
      },
    });
  } catch (error) {
    console.error('[mini-app] Error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// POST - Handle all actions
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { initData, action } = body;

  // Try to authenticate but allow public actions
  let telegramId: string | null = null;
  let isAdmin = false;
  let userRole = 'USER';

  if (initData && initData !== 'dev' && initData !== '') {
    const verified = verifyTelegramWebAppData(initData);
    if (verified.valid) {
      telegramId = verified.userId!;
      const telegramUser = await prisma.telegramUser.findUnique({
        where: { telegramId },
      });
      isAdmin = telegramUser?.role === 'ADMIN' || telegramUser?.role === 'SUPER_ADMIN';
      userRole = telegramUser?.role || 'USER';
    }
  }

  // Define public actions that don't require auth
  const publicActions = ['search', 'getRule', 'getStats', 'voiceSearch', 'getDocument'];
  
  if (!publicActions.includes(action) && !telegramId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  try {
    switch (action) {
      // ========== SEARCH & VOICE ==========
      case 'search': {
        const { query, confidenceFilter, domainFilter, dateFrom, dateTo, documentFilter } = body;
        if (!query && !domainFilter && !documentFilter) return NextResponse.json({ rules: [], qaPairs: [], total: 0 });

        let confidenceWhere: any = {};
        if (confidenceFilter === 'high') confidenceWhere = { confidence: { gte: 0.9 } };
        else if (confidenceFilter === 'medium') confidenceWhere = { confidence: { gte: 0.7, lt: 0.9 } };
        else if (confidenceFilter === 'low') confidenceWhere = { confidence: { lt: 0.7 } };

        let domainWhere: any = {};
        if (domainFilter) {
          domainWhere = { domains: { some: { domain: { slug: domainFilter } } } };
        }

        let dateWhere: any = {};
        if (dateFrom || dateTo) {
          dateWhere = {
            createdAt: {
              ...(dateFrom && { gte: new Date(dateFrom) }),
              ...(dateTo && { lte: new Date(dateTo) }),
            },
          };
        }

        let documentWhere: any = {};
        if (documentFilter) {
          documentWhere = { document: { title: { contains: documentFilter, mode: 'insensitive' } } };
        }

        const ruleSelect = {
          id: true,
          ruleCode: true,
          title: true,
          body: true,
          confidence: true,
          createdAt: true,
          sourceSpan: true,
          document: { select: { title: true, id: true } },
          domains: { include: { domain: { select: { slug: true, title: true } } } },
          _count: { select: { comments: true, favorites: true } },
        };

        const baseWhere = {
          status: 'ACTIVE' as const,
          ...confidenceWhere,
          ...domainWhere,
          ...dateWhere,
          ...documentWhere,
        };

        let rules: any[] = [];

        if (query?.trim()) {
          // Split query into meaningful words (>2 chars) for fallback strategies
          const queryWords = query.split(/\s+/).filter((w: string) => w.length > 2);

          // Build stem-based search terms (always run alongside FTS)
          // Strips 1-char suffix for words ≥7 chars: "доставку"→"доставк" matches all case forms
          const searchTerms = queryWords.length > 0 ? queryWords : [query];
          const stemmedTerms = searchTerms.flatMap((word: string) => {
            const terms = [word];
            if (word.length >= 7) terms.push(word.slice(0, -1));
            return [...new Set(terms)];
          });

          // Run FTS and stem-ILIKE in parallel, merge results
          const [ftsIds, ilikeRules] = await Promise.all([
            // Strategy 1: PostgreSQL FTS with Russian morphology
            (async () => {
              try {
                const andResults = await prisma.$queryRaw<Array<{ id: string }>>`
                  SELECT r.id FROM "Rule" r
                  WHERE r.status = 'ACTIVE'
                    AND to_tsvector('russian', coalesce(r.title, '') || ' ' || coalesce(r.body, ''))
                        @@ plainto_tsquery('russian', ${query})
                  ORDER BY ts_rank(
                    to_tsvector('russian', coalesce(r.title, '') || ' ' || coalesce(r.body, '')),
                    plainto_tsquery('russian', ${query})
                  ) DESC
                  LIMIT 100
                `;
                if (andResults.length > 0) return andResults.map((r: { id: string }) => r.id);
                // OR fallback for multi-word queries
                if (queryWords.length > 1) {
                  const orQuery = queryWords.join(' OR ');
                  const orResults = await prisma.$queryRaw<Array<{ id: string }>>`
                    SELECT r.id FROM "Rule" r
                    WHERE r.status = 'ACTIVE'
                      AND to_tsvector('russian', coalesce(r.title, '') || ' ' || coalesce(r.body, ''))
                          @@ websearch_to_tsquery('russian', ${orQuery})
                    LIMIT 100
                  `;
                  return orResults.map((r: { id: string }) => r.id);
                }
                return [];
              } catch {
                return [];
              }
            })(),
            // Strategy 2: Stem-based ILIKE (always runs, handles morphology gaps in FTS)
            prisma.rule.findMany({
              where: {
                ...baseWhere,
                OR: stemmedTerms.flatMap((word: string) => [
                  { title: { contains: word, mode: 'insensitive' as const } },
                  { body: { contains: word, mode: 'insensitive' as const } },
                  { ruleCode: { contains: word, mode: 'insensitive' as const } },
                ]),
              },
              take: 50,
              select: ruleSelect,
              orderBy: { confidence: 'desc' },
            }),
          ]);

          // Merge: FTS results first (by confidence), then add any ILIKE-only hits
          const ilikeById = new Map(ilikeRules.map(r => [r.id, r]));
          if (ftsIds.length > 0) {
            const ftsRules = await prisma.rule.findMany({
              where: { id: { in: ftsIds }, ...baseWhere },
              take: 50,
              select: ruleSelect,
              orderBy: { confidence: 'desc' },
            });
            const seen = new Set(ftsRules.map(r => r.id));
            const extra = ilikeRules.filter(r => !seen.has(r.id));
            rules = [...ftsRules, ...extra];
          } else {
            rules = ilikeRules;
          }
          // Deduplicate by ID (safety)
          rules = [...new Map(rules.map(r => [r.id, r])).values()];
        } else {
          // No text query — just apply filters
          rules = await prisma.rule.findMany({
            where: baseWhere,
            take: 50,
            select: ruleSelect,
          });
        }

        // QA pairs — same FTS strategy
        let qaPairs: any[] = [];
        if (query?.trim()) {
          const queryWords = query.split(/\s+/).filter((w: string) => w.length > 2);
          let qaMatchedIds: string[] = [];

          try {
            const qaAndResults = await prisma.$queryRaw<Array<{ id: string }>>`
              SELECT q.id FROM "QAPair" q
              WHERE q.status = 'ACTIVE'
                AND to_tsvector('russian', coalesce(q.question, '') || ' ' || coalesce(q.answer, ''))
                    @@ plainto_tsquery('russian', ${query})
              LIMIT 20
            `;
            qaMatchedIds = qaAndResults.map((r: { id: string }) => r.id);

            if (qaMatchedIds.length === 0 && queryWords.length > 1) {
              const orQuery = queryWords.join(' OR ');
              const qaOrResults = await prisma.$queryRaw<Array<{ id: string }>>`
                SELECT q.id FROM "QAPair" q
                WHERE q.status = 'ACTIVE'
                  AND to_tsvector('russian', coalesce(q.question, '') || ' ' || coalesce(q.answer, ''))
                      @@ websearch_to_tsquery('russian', ${orQuery})
                LIMIT 20
              `;
              qaMatchedIds = qaOrResults.map((r: { id: string }) => r.id);
            }
          } catch (e) {
            console.error('[search] QA FTS failed:', e);
          }

          if (qaMatchedIds.length > 0) {
            qaPairs = await prisma.qAPair.findMany({
              where: { id: { in: qaMatchedIds }, status: 'ACTIVE' },
              take: 10,
              select: {
                id: true,
                question: true,
                answer: true,
                rule: { select: { ruleCode: true, title: true } },
              },
            });
          } else {
            // ILIKE fallback for QA pairs with stem-based morphology
            const searchTerms = queryWords.length > 0 ? queryWords : [query];
            const stemmedTerms = searchTerms.flatMap((word: string) => {
              const terms = [word];
              if (word.length > 5) terms.push(word.slice(0, -2));
              if (word.length > 7) terms.push(word.slice(0, -3));
              return [...new Set(terms)];
            });
            qaPairs = await prisma.qAPair.findMany({
              where: {
                status: 'ACTIVE',
                OR: stemmedTerms.flatMap((word: string) => [
                  { question: { contains: word, mode: 'insensitive' as const } },
                  { answer: { contains: word, mode: 'insensitive' as const } },
                ]),
              },
              take: 10,
              select: {
                id: true,
                question: true,
                answer: true,
                rule: { select: { ruleCode: true, title: true } },
              },
            });
          }
        }

        return NextResponse.json({ rules, qaPairs, total: rules.length, _v: 'stem-v3' });
      }

      case 'getDocument': {
        const { documentId } = body;
        if (!documentId) return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });
        const doc = await prisma.document.findUnique({
          where: { id: documentId },
          select: { id: true, title: true, rawText: true },
        });
        if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
        return NextResponse.json({ document: doc });
      }

      case 'voiceSearch': {
        const { audioBase64 } = body;
        if (!audioBase64) return NextResponse.json({ error: 'No audio' }, { status: 400 });

        const { openai } = await import('@/lib/openai');
        const buffer = Buffer.from(audioBase64, 'base64');
        const blob = new Blob([buffer], { type: 'audio/ogg' });
        const file = new File([blob], 'voice.ogg', { type: 'audio/ogg' });

        const transcription = await openai.audio.transcriptions.create({
          file,
          model: 'whisper-1',
          language: 'ru',
        });

        return NextResponse.json({ transcript: transcription.text, success: true });
      }

      // ========== FAVORITES ==========
      case 'getFavorites': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const favorites = await prisma.userFavorite.findMany({
          where: { telegramId },
          include: {
            rule: {
              select: {
                id: true,
                ruleCode: true,
                title: true,
                confidence: true,
                document: { select: { title: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        });
        return NextResponse.json({ favorites });
      }

      case 'addFavorite': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { ruleId, notes } = body;
        if (!ruleId) return NextResponse.json({ error: 'Missing ruleId' }, { status: 400 });

        const favorite = await prisma.userFavorite.upsert({
          where: { telegramId_ruleId: { telegramId, ruleId } },
          update: { notes },
          create: { telegramId, ruleId, notes },
        });

        return NextResponse.json({ success: true, favorite });
      }

      case 'removeFavorite': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { ruleId } = body;
        if (!ruleId) return NextResponse.json({ error: 'Missing ruleId' }, { status: 400 });

        await prisma.userFavorite.deleteMany({
          where: { telegramId, ruleId },
        });

        return NextResponse.json({ success: true });
      }

      // ========== COMMENTS ==========
      case 'getComments': {
        const { ruleId } = body;
        if (!ruleId) return NextResponse.json({ error: 'Missing ruleId' }, { status: 400 });

        const comments = await prisma.ruleComment.findMany({
          where: { ruleId, isDeleted: false, parentId: null },
          include: {
            replies: {
              where: { isDeleted: false },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });

        return NextResponse.json({ comments });
      }

      case 'addComment': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { ruleId, content, parentId } = body;
        if (!ruleId || !content) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

        const comment = await prisma.ruleComment.create({
          data: {
            ruleId,
            telegramId,
            content,
            parentId: parentId || null,
          },
        });

        // Notify rule subscribers
        const subscribers = await prisma.userNotification.findMany({
          where: { ruleId, type: 'RULE_UPDATED', isActive: true },
        });

        for (const sub of subscribers) {
          if (sub.telegramId !== telegramId) {
            await prisma.notificationLog.create({
              data: {
                telegramId: sub.telegramId,
                type: 'RULE_UPDATED',
                title: 'Новый комментарий',
                message: `Новый комментарий к правилу`,
                ruleId,
              },
            });
          }
        }

        return NextResponse.json({ success: true, comment });
      }

      case 'editComment': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { commentId, content } = body;
        if (!commentId || !content) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

        const comment = await prisma.ruleComment.updateMany({
          where: { id: commentId, telegramId },
          data: { content, isEdited: true, updatedAt: new Date() },
        });

        return NextResponse.json({ success: true, comment });
      }

      case 'deleteComment': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { commentId } = body;
        if (!commentId) return NextResponse.json({ error: 'Missing commentId' }, { status: 400 });

        await prisma.ruleComment.updateMany({
          where: { id: commentId, telegramId },
          data: { isDeleted: true },
        });

        return NextResponse.json({ success: true });
      }

      // ========== NOTIFICATIONS ==========
      case 'getNotifications': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const notifications = await prisma.notificationLog.findMany({
          where: { telegramId },
          orderBy: { sentAt: 'desc' },
          take: 50,
        });

        const unreadCount = await prisma.notificationLog.count({
          where: { telegramId, isRead: false },
        });

        return NextResponse.json({ notifications, unreadCount });
      }

      case 'markNotificationsRead': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        await prisma.notificationLog.updateMany({
          where: { telegramId, isRead: false },
          data: { isRead: true, readAt: new Date() },
        });

        return NextResponse.json({ success: true });
      }

      case 'subscribe': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { type, domainId, ruleId, keywords } = body;
        
        const subscription = await prisma.userNotification.create({
          data: {
            telegramId,
            type,
            domainId: domainId || null,
            ruleId: ruleId || null,
            keywords: keywords || null,
          },
        });

        return NextResponse.json({ success: true, subscription });
      }

      case 'unsubscribe': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { subscriptionId } = body;
        
        await prisma.userNotification.deleteMany({
          where: { id: subscriptionId, telegramId },
        });

        return NextResponse.json({ success: true });
      }

      // ========== PREFERENCES ==========
      case 'updatePreferences': {
        if (!telegramId) return NextResponse.json({ error: 'Auth required' }, { status: 401 });
        const { theme, fontSize, offlineCache, pushEnabled, language } = body;

        const preferences = await prisma.userPreference.upsert({
          where: { telegramId },
          update: {
            ...(theme && { theme }),
            ...(fontSize && { fontSize }),
            ...(offlineCache !== undefined && { offlineCache }),
            ...(pushEnabled !== undefined && { pushEnabled }),
            ...(language && { language }),
            lastSyncedAt: new Date(),
          },
          create: {
            telegramId,
            theme: theme || 'system',
            fontSize: fontSize || 'medium',
            offlineCache: offlineCache !== false,
            pushEnabled: pushEnabled !== false,
            language: language || 'ru',
          },
        });

        return NextResponse.json({ success: true, preferences });
      }

      // ========== RULES ==========
      case 'getRule': {
        const { ruleId } = body;
        if (!ruleId) return NextResponse.json({ error: 'Missing ruleId' }, { status: 400 });

        const rule = await prisma.rule.findFirst({
          where: { id: ruleId, status: 'ACTIVE' },
          include: {
            document: { select: { title: true, id: true } },
            domains: { include: { domain: { select: { slug: true, title: true } } } },
            qaPairs: { where: { status: 'ACTIVE' } },
            _count: { select: { comments: true, favorites: true } },
          },
        });

        if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

        // Check if user favorited this rule
        const isFavorited = telegramId ? await prisma.userFavorite.findFirst({
          where: { telegramId, ruleId },
        }) : null;

        return NextResponse.json({ rule, isFavorited: !!isFavorited });
      }

      case 'shareRule': {
        const { ruleId, shareToChatId } = body;
        if (!ruleId) return NextResponse.json({ error: 'Missing ruleId' }, { status: 400 });

        const rule = await prisma.rule.findFirst({
          where: { id: ruleId, status: 'ACTIVE' },
          select: { ruleCode: true, title: true, body: true, confidence: true },
        });

        if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

        // Send via Telegram bot if shareToChatId provided
        if (shareToChatId) {
          const { sendMessage } = await import('@/lib/telegram/telegram-api');
          const message = `📌 ${rule.ruleCode}: ${rule.title}\n\n${rule.body}\n\n⭐ Уверенность: ${Math.round(rule.confidence * 100)}%`;
          await sendMessage(Number(shareToChatId), message);
        }

        return NextResponse.json({ success: true, rule });
      }

      case 'editRule': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });

        const { ruleId, title: newTitle, body: ruleBody, confirmEdit } = body;
        if (!ruleId || !newTitle || !ruleBody) return NextResponse.json({ error: 'Missing fields' }, { status: 400 });

        const existingRule = await prisma.rule.findFirst({
          where: { id: ruleId, status: 'ACTIVE' },
        });

        if (!existingRule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

        if (confirmEdit) {
          await prisma.rule.update({
            where: { id: existingRule.id },
            data: { status: 'SUPERSEDED' },
          });

          const allCodes2 = await prisma.rule.findMany({
            where: { ruleCode: { startsWith: 'R-' } },
            select: { ruleCode: true },
          });
          const maxNum2 = allCodes2.reduce((max, r) => {
            const n = parseInt(r.ruleCode.replace(/^R-/i, '')) || 0;
            return n > max ? n : max;
          }, 0);
          const newCode = `R-${maxNum2 + 1}`;

          const newRule = await prisma.rule.create({
            data: {
              ruleCode: newCode,
              title: newTitle,
              body: ruleBody,
              confidence: 1.0,
              documentId: existingRule.documentId,
              supersedesRuleId: existingRule.id,
              sourceSpan: { 
                quote: ruleBody.slice(0, 200), 
                locationHint: `Отредактировано через Mini App (${telegramId})` 
              },
            },
          });

          const domainLinks = await prisma.ruleDomain.findMany({
            where: { ruleId: existingRule.id },
          });
          for (const link of domainLinks) {
            await prisma.ruleDomain.create({
              data: { ruleId: newRule.id, domainId: link.domainId, confidence: link.confidence },
            });
          }

          // Notify subscribers
          const subscribers = await prisma.userNotification.findMany({
            where: { ruleId, type: 'RULE_UPDATED', isActive: true },
          });
          for (const sub of subscribers) {
            await prisma.notificationLog.create({
              data: {
                telegramId: sub.telegramId,
                type: 'RULE_UPDATED',
                title: 'Правило обновлено',
                message: `${existingRule.ruleCode} → ${newCode}: ${newTitle}`,
                ruleId: newRule.id,
              },
            });
          }

          return NextResponse.json({ success: true, rule: newRule, message: `Обновлено: ${existingRule.ruleCode} → ${newCode}` });
        } else {
          const updated = await prisma.rule.update({
            where: { id: existingRule.id },
            data: {
              title: newTitle,
              body: ruleBody,
              confidence: 1.0,
              sourceSpan: {
                ...(typeof existingRule.sourceSpan === 'object' && existingRule.sourceSpan !== null 
                  ? existingRule.sourceSpan 
                  : {}),
                editedVia: 'Mini App',
                editedBy: telegramId,
                editedAt: new Date().toISOString(),
              },
            },
          });

          return NextResponse.json({ success: true, rule: updated, message: `Правило ${existingRule.ruleCode} обновлено` });
        }
      }

      case 'confirmRule': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });

        const { ruleId } = body;
        if (!ruleId) return NextResponse.json({ error: 'Missing ruleId' }, { status: 400 });

        const rule = await prisma.rule.findFirst({
          where: { id: ruleId, status: 'ACTIVE' },
        });

        if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

        const updated = await prisma.rule.update({
          where: { id: rule.id },
          data: {
            confidence: 1.0,
            sourceSpan: {
              ...(typeof rule.sourceSpan === 'object' && rule.sourceSpan !== null 
                ? rule.sourceSpan 
                : {}),
              confirmedVia: 'Mini App',
              confirmedBy: telegramId,
              confirmedAt: new Date().toISOString(),
            },
          },
        });

        return NextResponse.json({ success: true, rule: updated, message: `Правило ${rule.ruleCode} подтверждено (100%)` });
      }

      case 'deleteRule': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });

        const { ruleId } = body;
        if (!ruleId) return NextResponse.json({ error: 'Missing ruleId' }, { status: 400 });

        const rule = await prisma.rule.findFirst({
          where: { id: ruleId, status: 'ACTIVE' },
        });

        if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });

        await prisma.rule.update({
          where: { id: rule.id },
          data: { status: 'DEPRECATED' },
        });

        await prisma.qAPair.updateMany({
          where: { ruleId: rule.id, status: 'ACTIVE' },
          data: { status: 'DEPRECATED' },
        });

        return NextResponse.json({ success: true, message: `Правило ${rule.ruleCode} удалено` });
      }

      // ========== ASK & HISTORY ==========
      case 'ask': {
        const { query } = body;
        if (!query) return NextResponse.json({ error: 'Missing query' }, { status: 400 });

        const session = await prisma.chatSession.create({
          data: { source: 'TELEGRAM', userId: telegramId || 'anonymous' },
        });

        await prisma.chatMessage.create({
          data: { sessionId: session.id, role: 'USER', content: query },
        });

        const { answerQuestionEnhanced } = await import('@/lib/ai/enhanced-answering-engine');
        const result = await answerQuestionEnhanced(query);

        await prisma.chatMessage.create({
          data: {
            sessionId: session.id,
            role: 'ASSISTANT',
            content: result.answer,
            metadata: {
              confidence: result.confidence,
              confidenceLevel: result.confidenceLevel,
              domainsUsed: result.domainsUsed,
              citationCount: result.citations.length,
            },
          },
        });

        return NextResponse.json({
          answer: result.answer,
          confidence: result.confidence,
          confidenceLevel: result.confidenceLevel,
          citations: result.citations,
          domainsUsed: result.domainsUsed,
          sessionId: session.id,
        });
      }

      // ========== DOCUMENT UPLOAD & PARSING ==========
      case 'uploadDocument': {
        if (userRole !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Только суперадмин может загружать документы' }, { status: 403 });

        const { fileBase64, filename, title } = body;
        if (!fileBase64 || !filename) {
          return NextResponse.json({ error: 'Missing fileBase64 or filename' }, { status: 400 });
        }

        const { parseDocument, detectMimeType } = await import('@/lib/document-parser');

        const buffer = Buffer.from(fileBase64, 'base64');
        const mimeType = detectMimeType(filename);

        // Prevent duplicate uploads
        const existingDoc = await prisma.document.findFirst({
          where: { filename },
          select: { id: true, title: true, parseStatus: true },
        });
        if (existingDoc) {
          return NextResponse.json({
            error: `Документ "${existingDoc.title}" уже загружен (${existingDoc.parseStatus})`,
            existingId: existingDoc.id,
          }, { status: 409 });
        }

        // Parse text from file
        let rawText: string;
        try {
          rawText = await parseDocument(buffer, mimeType, filename);
        } catch (parseError) {
          return NextResponse.json({
            error: `Не удалось прочитать документ: ${parseError instanceof Error ? parseError.message : 'Неизвестная ошибка'}`,
          }, { status: 400 });
        }

        const document = await prisma.document.create({
          data: {
            title: title || filename,
            filename,
            mimeType,
            rawBytes: buffer,
            rawText,
            parseStatus: 'PENDING',
          },
        });

        return NextResponse.json({
          success: true,
          documentId: document.id,
          message: `Документ "${document.title}" загружен (${rawText.length} символов).`,
        });
      }

      case 'getProcessingToken': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });

        const { documentId } = body;
        if (!documentId) return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });

        const doc = await prisma.document.findUnique({
          where: { id: documentId },
          select: { id: true, parseStatus: true },
        });
        if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

        const token = createProcessingToken(documentId);
        return NextResponse.json({ token, documentId });
      }

      case 'commitDocument': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });

        const { documentId } = body;
        if (!documentId) return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });

        const doc = await prisma.document.findUnique({
          where: { id: documentId },
          select: { id: true, parseStatus: true, title: true },
        });
        if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

        // Auto-verify all staged items
        await prisma.stagedExtraction.updateMany({
          where: { documentId },
          data: { isVerified: true, isRejected: false, verifiedAt: new Date() },
        });

        const { commitDocumentKnowledge } = await import('@/lib/document-processing/commit');
        const result = await commitDocumentKnowledge(documentId);
        return NextResponse.json(result);
      }

      case 'addRule': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });

        const { title: ruleTitle, body: ruleBody, domainIds: ruleDomainIds } = body;
        if (!ruleTitle || !ruleBody) {
          return NextResponse.json({ error: 'Необходимо указать заголовок и описание' }, { status: 400 });
        }

        // Get next rule code — must be numeric sort, not string sort (R-9 > R-100 alphabetically)
        const allCodes = await prisma.rule.findMany({
          where: { ruleCode: { startsWith: 'R-' } },
          select: { ruleCode: true },
        });
        const maxNum = allCodes.reduce((max, r) => {
          const n = parseInt(r.ruleCode.replace(/^R-/i, '')) || 0;
          return n > max ? n : max;
        }, 0);
        const newCode = `R-${maxNum + 1}`;

        const newRule = await prisma.rule.create({
          data: {
            ruleCode: newCode,
            title: ruleTitle,
            body: ruleBody,
            confidence: 1.0,
            sourceSpan: {
              quote: ruleBody.slice(0, 200),
              locationHint: `Добавлено вручную через Mini App (${telegramId})`,
            },
          },
        });

        if (Array.isArray(ruleDomainIds) && ruleDomainIds.length > 0) {
          for (const domainId of ruleDomainIds) {
            await prisma.ruleDomain.create({
              data: { ruleId: newRule.id, domainId, confidence: 1.0 },
            });
          }
        }

        return NextResponse.json({ success: true, rule: newRule, message: `Правило ${newCode} создано` });
      }

      case 'getDocuments': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });

        const documents = await prisma.document.findMany({
          select: {
            id: true,
            title: true,
            filename: true,
            parseStatus: true,
            parseError: true,
            retryCount: true,
            uploadedAt: true,
            _count: { select: { rules: true, qaPairs: true } },
          },
          orderBy: { uploadedAt: 'desc' },
          take: 30,
        });

        return NextResponse.json({ documents });
      }

      case 'reviveDocument': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        const { documentId } = body;
        if (!documentId) return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });

        const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, parseStatus: true } });
        if (!doc) return NextResponse.json({ error: 'Документ не найден' }, { status: 404 });

        await prisma.document.update({
          where: { id: documentId },
          data: { parseStatus: 'PENDING', retryCount: 0, parseError: null },
        });

        return NextResponse.json({ success: true, message: 'Документ реанимирован и готов к обработке' });
      }

      case 'getAttempts': {
        if (!isAdmin) return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        const { documentId } = body;
        if (!documentId) return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });

        const attempts = await prisma.processingAttempt.findMany({
          where: { documentId },
          orderBy: { startedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            startedAt: true,
            completedAt: true,
            status: true,
            errorMessage: true,
            failedPhase: true,
            durationMs: true,
          },
        });

        return NextResponse.json({ attempts });
      }

      case 'getHistory': {
        if (!telegramId) return NextResponse.json({ sessions: [] });
        const sessions = await prisma.chatSession.findMany({
          where: { source: 'TELEGRAM', userId: telegramId },
          orderBy: { updatedAt: 'desc' },
          take: 20,
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        });

        return NextResponse.json({ sessions });
      }

      case 'getStats': {
        const totalRules = await prisma.rule.count({ where: { status: 'ACTIVE' } });
        const totalQa = await prisma.qAPair.count({ where: { status: 'ACTIVE' } });
        const totalDocs = await prisma.document.count();
        
        const highConf = await prisma.rule.count({ where: { status: 'ACTIVE', confidence: { gte: 0.9 } } });
        const mediumConf = await prisma.rule.count({ where: { status: 'ACTIVE', confidence: { gte: 0.7, lt: 0.9 } } });
        const lowConf = await prisma.rule.count({ where: { status: 'ACTIVE', confidence: { lt: 0.7 } } });

        const recentActivity = await prisma.knowledgeChange.findMany({
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { rule: { select: { ruleCode: true, title: true } } },
        });

        // Documents list for filter
        const documents = await prisma.document.findMany({
          where: { parseStatus: 'COMPLETED' },
          orderBy: { uploadedAt: 'desc' },
          select: { id: true, title: true },
          take: 50,
        });

        return NextResponse.json({
          totalRules,
          totalQa,
          totalDocs,
          confidence: { high: highConf, medium: mediumConf, low: lowConf },
          recentActivity,
          documents,
        });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    console.error('[mini-app] Error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
