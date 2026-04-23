'use client';

import { useEffect, useState, useRef, createContext, useContext } from 'react';
import {
  Search, BookOpen, FileText, MessageCircle, ChevronRight, Star,
  AlertCircle, Mic, MicOff, Filter, History, BarChart3,
  Edit3, Trash2, CheckCircle, X, Save, ChevronLeft,
  ThumbsUp, ThumbsDown, Clock, TrendingUp, Heart, Share2,
  Bell, Moon, Sun, Settings, MessageSquare, Send, Reply,
  WifiOff, Calendar, FileSearch, MoreHorizontal, Check, Upload, FolderOpen,
  Plus, PlayCircle, DatabaseIcon
} from 'lucide-react';

// Theme Context
const ThemeContext = createContext({
  theme: 'system' as 'light' | 'dark' | 'system',
  isDark: false,
  setTheme: (t: 'light' | 'dark' | 'system') => {},
});

// Offline Context
const OfflineContext = createContext({
  isOnline: true,
  queue: [] as any[],
  addToQueue: (action: any) => {},
});

type Rule = {
  id: string;
  ruleCode: string;
  title: string;
  body?: string;
  confidence: number;
  createdAt?: string;
  sourceSpan?: { quote?: string; locationHint?: string } | null;
  document?: { title: string; id?: string };
  domains?: { domain: { slug: string; title: string } }[];
  qaPairs?: { id: string; question: string; answer: string }[];
  _count?: { comments: number; favorites: number };
};

type Domain = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  _count: { rules: number };
};

type ChatMessage = {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  createdAt: string;
  metadata?: any;
};

type ChatSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

type Comment = {
  id: string;
  telegramId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  isEdited: boolean;
  isDeleted: boolean;
  replies?: Comment[];
};

type Notification = {
  id: string;
  type: string;
  title: string;
  message: string;
  ruleId?: string;
  isRead: boolean;
  sentAt: string;
};

type UserPreferences = {
  theme: 'light' | 'dark' | 'system';
  fontSize: 'small' | 'medium' | 'large';
  offlineCache: boolean;
  pushEnabled: boolean;
};

export default function TelegramMiniApp() {
  // Core state
  const [initData, setInitData] = useState<string>('');
  const [user, setUser] = useState<{ first_name?: string; id?: number } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [role, setRole] = useState('USER');
  const [loading, setLoading] = useState(false);
  
  // Theme
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [isDark, setIsDark] = useState(false);
  
  // Offline
  const [isOnline, setIsOnline] = useState(true);
  const [offlineQueue, setOfflineQueue] = useState<any[]>([]);
  
  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ rules: Rule[]; qaPairs: any[]; total: number } | null>(null);
  const [aiAnswer, setAiAnswer] = useState<{
    answer?: string;
    needsClarification?: boolean;
    clarificationQuestion?: { question: string; options: string[] };
    primarySource?: { documentId: string; documentTitle: string; chunkContent: string; relevanceScore: number };
    supplementarySources?: Array<{ documentId: string; documentTitle: string; chunkContent: string; relevanceScore: number }>;
    scenarioKey?: string;
    scenarioLabel?: string;
  } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  // Accumulates clarification-answer labels across multiple disambiguation
  // steps (e.g. apostille → zags → spb needs two clicks). Reset on new
  // search. Sent as a single joined string so the gate can reclassify against
  // the full user context, not just the latest click.
  const [clarificationChain, setClarificationChain] = useState<string[]>([]);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [confidenceFilter, setConfidenceFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [domainFilter, setDomainFilter] = useState<string>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [documentFilter, setDocumentFilter] = useState('');
  const [documents, setDocuments] = useState<{
    id: string; title: string; filename: string; parseStatus: string;
    parseError?: string | null; retryCount?: number; uploadedAt: string;
    _count?: { rules: number; qaPairs: number };
  }[]>([]);
  
  // Data
  const [recentRules, setRecentRules] = useState<Rule[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [history, setHistory] = useState<ChatSession[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [favorites, setFavorites] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  
  // UI state
  const [selectedRule, setSelectedRule] = useState<Rule | null>(null);
  const [docViewer, setDocViewer] = useState<{ title: string; text: string; quote?: string } | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [isFavorited, setIsFavorited] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [activeTab, setActiveTab] = useState<'search' | 'rules' | 'pairs' | 'recent' | 'history' | 'stats' | 'favorites' | 'notifications' | 'documents'>('search');
  const [allRules, setAllRules] = useState<any[]>([]);
  const [allPairs, setAllPairs] = useState<any[]>([]);
  const [allRulesTotal, setAllRulesTotal] = useState(0);
  const [allPairsTotal, setAllPairsTotal] = useState(0);
  const [showSettings, setShowSettings] = useState(false);

  // Document knowledge viewer
  const [viewingDocKnowledge, setViewingDocKnowledge] = useState<any | null>(null);
  const [docKnowledge, setDocKnowledge] = useState<{ rules: any[]; pairs: any[]; chunks: any[] } | null>(null);
  const [docKnowledgeTab, setDocKnowledgeTab] = useState<'rules' | 'pairs' | 'chunks'>('rules');
  const [docKnowledgeLoading, setDocKnowledgeLoading] = useState(false);
  
  // Document upload (admin only)
  const [docList, setDocList] = useState<any[]>([]);
  const [docUploading, setDocUploading] = useState(false);
  const [docUploadMessage, setDocUploadMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const listScrollRef = useRef(0);

  // Document processing (admin)
  const [processingDocId, setProcessingDocId] = useState<string | null>(null);
  const [processingDocTitle, setProcessingDocTitle] = useState('');
  const [processingLog, setProcessingLog] = useState<string[]>([]);
  const [processingDone, setProcessingDone] = useState(false);
  const [processingErr, setProcessingErr] = useState<string | null>(null);

  // Staged items review
  const [reviewingDoc, setReviewingDoc] = useState<{ id: string; title: string } | null>(null);
  const [stagedItems, setStagedItems] = useState<any[]>([]);
  const [stagedTab, setStagedTab] = useState<'rules' | 'qa' | 'chunks'>('rules');
  const [editingStagedId, setEditingStagedId] = useState<string | null>(null);
  const [editStagedData, setEditStagedData] = useState<any>(null);
  const [stagedLoading, setStagedLoading] = useState(false);

  // Add rule (admin)
  const [addingRule, setAddingRule] = useState(false);
  const [newRuleTitle, setNewRuleTitle] = useState('');
  const [newRuleBody, setNewRuleBody] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Voice recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize
  useEffect(() => {
    // Online/offline detection
    setIsOnline(navigator.onLine);
    window.addEventListener('online', () => setIsOnline(true));
    window.addEventListener('offline', () => setIsOnline(false));

    // Load cached data immediately
    const cached = localStorage.getItem('miniapp_data');
    if (cached) {
      try {
        const data = JSON.parse(cached);
        setRecentRules(data.recentRules || []);
        setDomains(data.domains || []);
        setFavorites(data.favorites || []);
        setStats(data.stats || null);
      } catch {}
    }

    // Load preferences
    const prefs = localStorage.getItem('miniapp_prefs');
    if (prefs) {
      try {
        const p = JSON.parse(prefs);
        setTheme(p.theme || 'system');
      } catch {}
    }

    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.ready();
      tg.expand();
      
      const initDataRaw = tg.initData || '';
      setInitData(initDataRaw);
      
      if (tg.initDataUnsafe?.user) {
        setUser(tg.initDataUnsafe.user);
      }
      
      // Check Telegram theme
      if (tg.colorScheme) {
        const isDarkMode = tg.colorScheme === 'dark';
        setIsDark(isDarkMode);
        document.body.classList.toggle('dark', isDarkMode);
      }
      
      // Load data immediately with Telegram initData
      loadInitialData(initDataRaw);
    } else {
      // Development mode - try to load without auth or with dev token
      setUser({ first_name: 'Test User' });
      loadInitialData('');
    }
  }, []);

  // Reload data when initData changes
  useEffect(() => {
    if (initData) {
      loadInitialData(initData);
    }
  }, [initData]);

  // Theme effect
  useEffect(() => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldBeDark = theme === 'dark' || (theme === 'system' && systemDark);
    setIsDark(shouldBeDark);
    document.body.classList.toggle('dark', shouldBeDark);

    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.setHeaderColor(shouldBeDark ? '#1f2937' : '#ffffff');
      window.Telegram.WebApp.setBackgroundColor(shouldBeDark ? '#1f2937' : '#f5f5f5');
    }
  }, [theme]);

  // Auto-scroll to highlighted quote in document viewer
  useEffect(() => {
    if (docViewer?.quote) {
      setTimeout(() => {
        document.getElementById('doc-highlight')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [docViewer]);

  // Restore scroll position when returning from rule detail to list
  useEffect(() => {
    if (!selectedRule && listScrollRef.current > 0) {
      const pos = listScrollRef.current;
      listScrollRef.current = 0;
      setTimeout(() => window.scrollTo({ top: pos, behavior: 'instant' as ScrollBehavior }), 0);
    }
  }, [selectedRule]);

  const loadInitialData = async (dataParam?: string) => {
    const initDataToUse = dataParam || initData || 'dev';
    try {
      const response = await fetch(`/api/telegram/mini-app?initData=${encodeURIComponent(initDataToUse)}`);
      if (response.ok) {
        const data = await response.json();
        setRecentRules(data.recentRules || []);
        setDomains(data.domains || []);
        setIsAdmin(data.isAdmin);
        setRole(data.role);
        setFavorites(data.favorites || []);
        setNotifications(data.notifications?.items || []);
        setUnreadCount(data.notifications?.unreadCount || 0);
        
        if (data.preferences) {
          setTheme(data.preferences.theme);
        }
        
        if (data.history) {
          const sessionsMap = new Map();
          data.history.forEach((msg: ChatMessage & { sessionId: string }) => {
            if (!sessionsMap.has(msg.sessionId)) {
              sessionsMap.set(msg.sessionId, {
                id: msg.sessionId,
                messages: [],
                createdAt: msg.createdAt,
                updatedAt: msg.createdAt,
              });
            }
            sessionsMap.get(msg.sessionId).messages.push(msg);
          });
          setHistory(Array.from(sessionsMap.values()).sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          ));
        }
        
        setStats(data.stats);
        
        // Cache data for offline
        localStorage.setItem('miniapp_data', JSON.stringify({
          recentRules: data.recentRules,
          domains: data.domains,
          favorites: data.favorites,
          timestamp: Date.now(),
        }));
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    }
  };

  const savePreferences = async (prefs: Partial<UserPreferences>) => {
    const newPrefs = { theme, fontSize: 'medium', offlineCache: true, pushEnabled: true, ...prefs };
    localStorage.setItem('miniapp_prefs', JSON.stringify(newPrefs));
    
    try {
      await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'updatePreferences',
          ...prefs,
        }),
      });
    } catch (error) {
      console.error('Failed to save preferences:', error);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() && !domainFilter && !documentFilter && !dateFrom && !dateTo) return;

    setLoading(true);
    setAiAnswer(null);

    // Run search + AI answer in parallel when there's a text query
    const searchFetch = fetch('/api/telegram/mini-app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initData: initData || 'dev',
        action: 'search',
        query: searchQuery || ' ',
        confidenceFilter,
        domainFilter: domainFilter || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        documentFilter: documentFilter || undefined,
      }),
    });

    const aiFetch = searchQuery.trim()
      ? fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: searchQuery }),
        })
      : null;

    try {
      setAiLoading(!!aiFetch);
      const [searchRes, aiRes] = await Promise.allSettled([searchFetch, aiFetch ?? Promise.resolve(null)]);

      if (searchRes.status === 'fulfilled' && searchRes.value?.ok) {
        const data = await searchRes.value.json();
        setSearchResults(data);
        setActiveTab('search');
      }

      if (aiRes.status === 'fulfilled' && aiRes.value?.ok) {
        const aiData = await aiRes.value.json();
        if (aiData.answer !== undefined || aiData.clarificationQuestion) {
          setClarificationChain([]); // new query → reset chain
          setAiAnswer({
            answer: aiData.answer,
            needsClarification: aiData.needsClarification,
            clarificationQuestion: aiData.clarificationQuestion,
            primarySource: aiData.primarySource,
            supplementarySources: aiData.supplementarySources,
            scenarioKey: aiData.scenarioKey,
            scenarioLabel: aiData.scenarioLabel,
          });
        }
      }
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
      setAiLoading(false);
    }
  };

  // Accumulate clarification choices so multi-level paths (e.g. apostille →
  // zags → spb) preserve earlier answers instead of overwriting them.
  const handleClarificationAnswer = async (option: string) => {
    if (!searchQuery.trim()) return;
    setAiLoading(true);
    setAiAnswer(null);
    const nextChain = [...clarificationChain, option];
    setClarificationChain(nextChain);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: searchQuery,
          clarificationAnswer: nextChain.join(' → '),
        }),
      });
      if (res.ok) {
        const aiData = await res.json();
        setAiAnswer({
          answer: aiData.answer,
          needsClarification: aiData.needsClarification,
          clarificationQuestion: aiData.clarificationQuestion,
          primarySource: aiData.primarySource,
          supplementarySources: aiData.supplementarySources,
          scenarioKey: aiData.scenarioKey,
          scenarioLabel: aiData.scenarioLabel,
        });
      }
    } catch (e) {
      console.error('Clarification fetch failed:', e);
    } finally {
      setAiLoading(false);
    }
  };

  const loadAllRules = async (cursor?: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'getAllRules', cursor, limit: 50 }),
      });
      if (res.ok) {
        const data = await res.json();
        setAllRules(prev => cursor ? [...prev, ...data.rules] : data.rules);
        setAllRulesTotal(data.total);
      }
    } catch (e) {
      console.error('loadAllRules failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadAllPairs = async (cursor?: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'getAllPairs', cursor, limit: 50 }),
      });
      if (res.ok) {
        const data = await res.json();
        setAllPairs(prev => cursor ? [...prev, ...data.pairs] : data.pairs);
        setAllPairsTotal(data.total);
      }
    } catch (e) {
      console.error('loadAllPairs failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadDocumentKnowledge = async (doc: any, initialTab: 'rules' | 'pairs' | 'chunks' = 'rules') => {
    setViewingDocKnowledge(doc);
    setDocKnowledge(null);
    setDocKnowledgeLoading(true);
    setDocKnowledgeTab(initialTab);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'getDocumentKnowledge', documentId: doc.id }),
      });
      if (res.ok) {
        const data = await res.json();
        setDocKnowledge(data);
      }
    } catch (e) {
      console.error('loadDocumentKnowledge failed:', e);
    } finally {
      setDocKnowledgeLoading(false);
    }
  };

  // Document upload (admin)
  const loadDocuments = async () => {
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'getDocuments' }),
      });
      if (res.ok) {
        const data = await res.json();
        setDocList(data.documents || []);
      }
    } catch (e) {
      console.error('loadDocuments failed:', e);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      setDocUploading(true);
      setDocUploadMessage('');
      try {
        const res = await fetch('/api/telegram/mini-app', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            initData: initData || 'dev',
            action: 'uploadDocument',
            fileBase64: base64,
            filename: file.name,
            title: file.name.replace(/\.[^.]+$/, ''),
          }),
        });
        const data = await res.json();
        setDocUploadMessage(res.ok ? data.message : (data.error || 'Ошибка загрузки'));
        if (res.ok) loadDocuments();
      } catch (err) {
        setDocUploadMessage('Ошибка сети при загрузке');
      } finally {
        setDocUploading(false);
        // Reset input so same file can be selected again
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  };

  // Voice recording
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/ogg' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64 = (reader.result as string).split(',')[1];
          
          setLoading(true);
          try {
            const response = await fetch('/api/telegram/mini-app', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                initData: initData || 'dev',
                action: 'voiceSearch',
                audioBase64: base64,
              }),
            });
            
            if (response.ok) {
              const data = await response.json();
              if (data.transcript) {
                setSearchQuery(data.transcript);
                setTimeout(() => handleSearch(), 100);
              }
            }
          } catch (error) {
            console.error('Voice search failed:', error);
          } finally {
            setLoading(false);
          }
        };
      };
      
      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      
      timerRef.current = setInterval(() => {
        setRecordingTime(t => t + 1);
      }, 1000);
    } catch (error) {
      alert('Не удалось получить доступ к микрофону');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
    setRecordingTime(0);
  };

  // Favorites
  const toggleFavorite = async (ruleId: string) => {
    const isCurrentlyFavorited = favorites.some(f => f.ruleId === ruleId);
    
    // Optimistic update
    if (isCurrentlyFavorited) {
      setFavorites(favorites.filter(f => f.ruleId !== ruleId));
      setIsFavorited(false);
    } else {
      setFavorites([...favorites, { ruleId, rule: selectedRule }]);
      setIsFavorited(true);
    }
    
    try {
      await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: isCurrentlyFavorited ? 'removeFavorite' : 'addFavorite',
          ruleId,
        }),
      });
    } catch (error) {
      // Revert on error
      if (isCurrentlyFavorited) {
        setFavorites([...favorites, { ruleId, rule: selectedRule }]);
      } else {
        setFavorites(favorites.filter(f => f.ruleId !== ruleId));
      }
    }
  };

  // Comments
  const loadComments = async (ruleId: string) => {
    try {
      const response = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'getComments',
          ruleId,
        }),
      });
      
      if (response.ok) {
        const data = await response.json();
        setComments(data.comments);
      }
    } catch (error) {
      console.error('Failed to load comments:', error);
    }
  };

  const addComment = async () => {
    if (!selectedRule || !newComment.trim()) return;
    
    try {
      const response = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'addComment',
          ruleId: selectedRule.id,
          content: newComment,
          parentId: replyTo,
        }),
      });
      
      if (response.ok) {
        setNewComment('');
        setReplyTo(null);
        loadComments(selectedRule.id);
      }
    } catch (error) {
      console.error('Failed to add comment:', error);
    }
  };

  // Share
  const shareRule = async (rule: Rule) => {
    const text = `📌 ${rule.ruleCode}: ${rule.title}\n\n${rule.body?.slice(0, 200)}...\n\n⭐ Уверенность: ${Math.round(rule.confidence * 100)}%`;
    
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.showPopup({
        title: 'Поделиться',
        message: 'Отправить правило в текущий чат?',
        buttons: [
          { id: 'share', type: 'default', text: 'Отправить' },
          { type: 'cancel' },
        ],
      }, async (buttonId) => {
        if (buttonId === 'share') {
          window.Telegram?.WebApp.sendData(JSON.stringify({
            action: 'share_rule',
            ruleId: rule.id,
          }));
        }
      });
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(text);
      alert('Скопировано в буфер обмена');
    }
  };

  // Notifications
  const markNotificationsRead = async () => {
    setUnreadCount(0);
    setNotifications(notifications.map(n => ({ ...n, isRead: true })));
    
    try {
      await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'markNotificationsRead',
        }),
      });
    } catch (error) {
      console.error('Failed to mark notifications read:', error);
    }
  };

  // ======== ADMIN RULE ACTIONS ========

  const handleEditRuleSave = async () => {
    if (!selectedRule) return;
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'editRule',
          ruleId: selectedRule.id,
          title: editTitle,
          body: editBody,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setActionMsg(data.message || 'Правило обновлено');
        setEditingRule(false);
        // Refresh rule
        await handleRuleClick(selectedRule);
      } else {
        setActionMsg(data.error || 'Ошибка обновления');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Удалить это правило?')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'deleteRule', ruleId }),
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedRule(null);
        setActionMsg(data.message || 'Правило удалено');
      } else {
        setActionMsg(data.error || 'Ошибка удаления');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmRule = async (ruleId: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'confirmRule', ruleId }),
      });
      const data = await res.json();
      setActionMsg(data.message || (res.ok ? 'Подтверждено' : data.error));
      if (res.ok) {
        // Update confidence in the list so badge refreshes when user goes back
        setSearchResults(prev => prev ? {
          ...prev,
          rules: prev.rules.map(r => r.id === ruleId ? { ...r, confidence: 1.0 } : r),
        } : prev);
        if (selectedRule) await handleRuleClick(selectedRule);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAddRule = async () => {
    if (!newRuleTitle.trim() || !newRuleBody.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'addRule',
          title: newRuleTitle,
          body: newRuleBody,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setActionMsg(data.message);
        setAddingRule(false);
        setNewRuleTitle('');
        setNewRuleBody('');
      } else {
        setActionMsg(data.error || 'Ошибка создания правила');
      }
    } finally {
      setLoading(false);
    }
  };

  // ======== DOCUMENT PROCESSING ========

  const handleProcessDocument = async (docId: string, docTitle: string) => {
    setProcessingDocId(docId);
    setProcessingDocTitle(docTitle);
    setProcessingLog([`Запускаем обработку: ${docTitle}`]);
    setProcessingDone(false);
    setProcessingErr(null);

    try {
      // 1. Get processing token
      const tokenRes = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'getProcessingToken', documentId: docId }),
      });
      if (!tokenRes.ok) {
        const err = await tokenRes.json();
        setProcessingErr(err.error || 'Не удалось получить токен');
        return;
      }
      const { token } = await tokenRes.json();

      // 2. Open SSE stream
      setProcessingLog(prev => [...prev, 'Подключение к потоку обработки...']);
      const evtSource = new EventSource(`/api/documents/${docId}/process-stream?token=${token}`);
      eventSourceRef.current = evtSource;
      let streamDone = false;

      evtSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'phase_start') {
            const phaseNames: Record<string, string> = {
              DOMAIN_CLASSIFICATION: '🏷 Классификация домена',
              KNOWLEDGE_EXTRACTION: '📚 Извлечение знаний',
              CHUNKING: '✂️ Нарезка на чанки',
            };
            setProcessingLog(prev => [...prev, `\n${phaseNames[event.phase] || event.phase}...`]);
          } else if (event.type === 'item_extracted') {
            const d = event.data as any;
            const label = d?.itemType === 'RULE' ? `📌 ${d?.title || 'правило'}`
              : d?.itemType === 'QA_PAIR' ? `❓ ${d?.question?.slice(0, 60) || 'вопрос'}`
              : d?.itemType === 'CHUNK' ? `🧩 чанк ${d?.index ?? ''}`
              : `✔ ${d?.itemType || 'элемент'}`;
            setProcessingLog(prev => [...prev, label]);
          } else if (event.type === 'phase_complete') {
            setProcessingLog(prev => [...prev, '✅ Фаза завершена']);
          } else if (event.type === 'complete') {
            streamDone = true;
            setProcessingLog(prev => [...prev, '\n🎉 Обработка завершена! Нажмите "Сохранить" для записи в базу.']);
            setProcessingDone(true);
            evtSource.close();
            eventSourceRef.current = null;
          } else if (event.type === 'fatal_error' || event.type === 'error') {
            streamDone = true;
            const isDead = (event.data as any)?.code === 'DEAD';
            const errMsg = (event.data as any)?.message || 'Ошибка обработки';
            setProcessingErr(isDead ? `__DLQ__${errMsg}` : errMsg);
            evtSource.close();
            eventSourceRef.current = null;
          }
        } catch {}
      };

      evtSource.onerror = () => {
        if (!streamDone) {
          streamDone = true;
          setProcessingErr('Соединение прервано');
          evtSource.close();
        }
      };
    } catch (err) {
      setProcessingErr('Ошибка запуска обработки');
    }
  };

  const handleCommitDocument = async () => {
    if (!processingDocId) return;
    setProcessingLog(prev => [...prev, '\nСохраняем в базу знаний...']);
    setLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'commitDocument', documentId: processingDocId }),
      });
      const data = await res.json();
      if (res.ok) {
        const r = data.results || {};
        setProcessingLog(prev => [...prev,
          `✅ Сохранено: ${r.rulesCreated || 0} правил, ${r.qaPairsCreated || 0} вопросов, ${r.chunksCreated || 0} чанков`
        ]);
        setProcessingDone(false);
        await loadDocuments();
        // Close after a moment
        setTimeout(() => setProcessingDocId(null), 3000);
      } else {
        setProcessingLog(prev => [...prev, `❌ Ошибка: ${data.error || 'неизвестная ошибка'}`]);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadStagedItems = async (docId: string, docTitle: string) => {
    setStagedLoading(true);
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'getStagedItems', documentId: docId }),
      });
      if (res.ok) {
        const data = await res.json();
        setStagedItems(data.items || []);
        setStagedTab('rules');
        setEditingStagedId(null);
        setReviewingDoc({ id: docId, title: docTitle });
      }
    } catch (e) {
      console.error('Failed to load staged items:', e);
    } finally {
      setStagedLoading(false);
    }
  };

  const handleUpdateStagedItem = async (stagedId: string, newData: any) => {
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'updateStagedItem', stagedId, data: newData }),
      });
      if (res.ok) {
        setStagedItems(prev => prev.map(item => item.id === stagedId ? { ...item, data: newData } : item));
        setEditingStagedId(null);
      }
    } catch (e) {
      console.error('Failed to update staged item:', e);
    }
  };

  const handleDeleteStagedItem = async (stagedId: string) => {
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'deleteStagedItem', stagedId }),
      });
      if (res.ok) {
        setStagedItems(prev => prev.filter(item => item.id !== stagedId));
      }
    } catch (e) {
      console.error('Failed to delete staged item:', e);
    }
  };

  const openDocument = async (documentId: string, quote?: string) => {
    try {
      const res = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData || 'dev', action: 'getDocument', documentId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.document?.rawText) {
          setActionMsg('Текст документа недоступен (документ не был обработан)');
          return;
        }
        setDocViewer({ title: data.document.title, text: data.document.rawText, quote });
      } else {
        setActionMsg('Не удалось открыть документ');
      }
    } catch (e) {
      console.error('Failed to load document:', e);
      setActionMsg('Ошибка загрузки документа');
    }
  };

  const handleRuleClick = async (rule: Rule) => {
    // Save current scroll so we can restore it when user goes back
    if (!selectedRule) listScrollRef.current = window.scrollY;
    setLoading(true);
    try {
      const response = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'getRule',
          ruleId: rule.id,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setSelectedRule(data.rule);
        setEditTitle(data.rule.title);
        setEditBody(data.rule.body || '');
        setEditingRule(false);
        setIsFavorited(data.isFavorited);
        loadComments(rule.id);
      }
    } catch (error) {
      console.error('Failed to load rule:', error);
    } finally {
      setLoading(false);
    }
  };

  // Stats with documents
  const loadStats = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/telegram/mini-app', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'dev',
          action: 'getStats',
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setStats(data);
        setDocuments(data.documents || []);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.9) return 'text-green-600 bg-green-50 dark:bg-green-900/20 dark:text-green-400';
    if (confidence >= 0.7) return 'text-yellow-600 bg-yellow-50 dark:bg-yellow-900/20 dark:text-yellow-400';
    return 'text-orange-600 bg-orange-50 dark:bg-orange-900/20 dark:text-orange-400';
  };

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 0.9) return { text: 'Высокая', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' };
    if (confidence >= 0.7) return { text: 'Средняя', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' };
    return { text: 'Низкая', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300' };
  };

  // ======== DOCUMENT KNOWLEDGE VIEWER (committed data) ========
  if (viewingDocKnowledge) {
    const knowledgeTabItems = docKnowledgeTab === 'rules'
      ? (docKnowledge?.rules ?? [])
      : docKnowledgeTab === 'pairs'
        ? (docKnowledge?.pairs ?? [])
        : (docKnowledge?.chunks ?? []);

    return (
      <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
        <div className={`min-h-screen flex flex-col ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
          {/* Header */}
          <div className={`flex items-center gap-3 px-4 py-3 border-b ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            <button onClick={() => setViewingDocKnowledge(null)} className="p-1">
              <ChevronLeft className={`w-5 h-5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`} />
            </button>
            <div className="flex-1 min-w-0">
              <p className={`font-semibold text-sm truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {viewingDocKnowledge.title}
              </p>
              <p className={`text-xs truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                База знаний документа
              </p>
            </div>
          </div>

          {/* Tabs */}
          <div className={`flex border-b ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            {[
              { id: 'rules', label: `Правила (${docKnowledge?.rules.length ?? '…'})` },
              { id: 'pairs', label: `Вопросы (${docKnowledge?.pairs.length ?? '…'})` },
              { id: 'chunks', label: `Чанки (${docKnowledge?.chunks.length ?? '…'})` },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => setDocKnowledgeTab(t.id as any)}
                className={`flex-1 py-3 text-sm font-medium border-b-2 ${
                  docKnowledgeTab === t.id
                    ? 'border-blue-600 text-blue-600'
                    : `border-transparent ${isDark ? 'text-gray-400' : 'text-gray-500'}`
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-8">
            {docKnowledgeLoading && (
              <div className="text-center py-12 text-gray-400">Загрузка...</div>
            )}
            {!docKnowledgeLoading && knowledgeTabItems.length === 0 && (
              <div className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Нет элементов этого типа
              </div>
            )}

            {docKnowledgeTab === 'rules' && docKnowledge?.rules.map(rule => (
              <div
                key={rule.id}
                onClick={() => { setViewingDocKnowledge(null); handleRuleClick(rule); }}
                className={`p-4 rounded-xl shadow-sm cursor-pointer hover:shadow-md transition-shadow ${isDark ? 'bg-gray-800' : 'bg-white'}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-blue-600 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded">
                    {rule.ruleCode}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    (rule.confidence ?? 0) >= 0.9
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : (rule.confidence ?? 0) >= 0.7
                        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                  }`}>
                    {Math.round((rule.confidence ?? 0) * 100)}%
                  </span>
                </div>
                <p className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{rule.title}</p>
                {rule.body && (
                  <p className={`text-xs line-clamp-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{rule.body}</p>
                )}
              </div>
            ))}

            {docKnowledgeTab === 'pairs' && docKnowledge?.pairs.map(pair => (
              <div key={pair.id} className={`p-4 rounded-xl shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
                <p className={`text-sm font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>{pair.question}</p>
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{pair.answer}</p>
              </div>
            ))}

            {docKnowledgeTab === 'chunks' && docKnowledge?.chunks.map(chunk => (
              <div key={chunk.id} className={`p-3 rounded-xl shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
                <div className={`flex gap-2 mb-1 text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  <span>#{chunk.chunkIndex + 1}</span>
                </div>
                <p className={`text-xs leading-relaxed line-clamp-4 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  {chunk.content}
                </p>
              </div>
            ))}
          </div>
        </div>
      </ThemeContext.Provider>
    );
  }

  // ======== STAGED ITEMS REVIEW SCREEN ========
  if (reviewingDoc) {
    const rules  = stagedItems.filter(i => i.itemType === 'RULE');
    const qaPairs = stagedItems.filter(i => i.itemType === 'QA_PAIR');
    const chunks  = stagedItems.filter(i => i.itemType === 'CHUNK');

    const tabItems = stagedTab === 'rules' ? rules : stagedTab === 'qa' ? qaPairs : chunks;
    const totalActive = stagedItems.length;

    return (
      <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
        <div className={`min-h-screen flex flex-col ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
          {/* Header */}
          <div className={`sticky top-0 z-10 border-b px-4 py-3 flex items-center gap-3 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            <button onClick={() => setReviewingDoc(null)} className="p-1">
              <ChevronLeft className={`w-5 h-5 ${isDark ? 'text-white' : 'text-gray-900'}`} />
            </button>
            <div className="flex-1 min-w-0">
              <h2 className={`font-semibold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>Проверка результатов</h2>
              <p className={`text-xs truncate ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{reviewingDoc.title}</p>
            </div>
          </div>

          {/* Summary pills */}
          <div className="flex gap-2 px-4 pt-3 pb-1">
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${isDark ? 'bg-blue-900/40 text-blue-300' : 'bg-blue-100 text-blue-700'}`}>
              📌 {rules.length} правил
            </span>
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${isDark ? 'bg-purple-900/40 text-purple-300' : 'bg-purple-100 text-purple-700'}`}>
              ❓ {qaPairs.length} вопросов
            </span>
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
              🧩 {chunks.length} чанков
            </span>
          </div>

          {/* Tabs */}
          <div className={`flex border-b ${isDark ? 'border-gray-700' : 'border-gray-200'} px-4`}>
            {(['rules', 'qa', 'chunks'] as const).map(tab => {
              const label = tab === 'rules' ? `Правила (${rules.length})` : tab === 'qa' ? `Вопросы (${qaPairs.length})` : `Чанки (${chunks.length})`;
              return (
                <button
                  key={tab}
                  onClick={() => { setStagedTab(tab); setEditingStagedId(null); }}
                  className={`py-2 px-3 text-sm font-medium border-b-2 transition-colors ${
                    stagedTab === tab
                      ? 'border-blue-500 text-blue-600'
                      : `border-transparent ${isDark ? 'text-gray-400' : 'text-gray-500'}`
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Items list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-32">
            {tabItems.length === 0 && (
              <div className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Нет элементов этого типа
              </div>
            )}

            {tabItems.map(item => {
              const isEditing = editingStagedId === item.id;
              const d = item.data as any;

              return (
                <div key={item.id} className={`rounded-xl shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
                  {item.itemType === 'RULE' && (
                    <div className="p-4">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input
                            className={`w-full px-3 py-2 border rounded-lg text-sm font-medium ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'border-gray-300'}`}
                            value={editStagedData?.title ?? d.title}
                            onChange={e => setEditStagedData((prev: any) => ({ ...(prev ?? d), title: e.target.value }))}
                            placeholder="Заголовок правила"
                          />
                          <textarea
                            rows={5}
                            className={`w-full px-3 py-2 border rounded-lg text-sm resize-none ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'border-gray-300'}`}
                            value={editStagedData?.body ?? d.body}
                            onChange={e => setEditStagedData((prev: any) => ({ ...(prev ?? d), body: e.target.value }))}
                            placeholder="Описание"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleUpdateStagedItem(item.id, { ...d, ...(editStagedData ?? {}) })}
                              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
                            >
                              Сохранить
                            </button>
                            <button
                              onClick={() => { setEditingStagedId(null); setEditStagedData(null); }}
                              className={`px-4 py-2 rounded-lg text-sm border ${isDark ? 'border-gray-600 text-gray-300' : 'border-gray-300 text-gray-600'}`}
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className={`font-semibold text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>{d.ruleCode} — {d.title}</p>
                              {d.body && <p className={`text-sm mt-1 line-clamp-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{d.body}</p>}
                            </div>
                            <div className="flex gap-1 flex-shrink-0">
                              {d.confidence < 1.0 && (
                                <button
                                  onClick={() => handleUpdateStagedItem(item.id, { ...d, confidence: 1.0 })}
                                  title="Подтвердить — 100% уверенность"
                                  className={`p-2 rounded-lg ${isDark ? 'hover:bg-green-900/30 text-green-400' : 'hover:bg-green-50 text-green-600'}`}
                                >
                                  <CheckCircle className="w-4 h-4" />
                                </button>
                              )}
                              <button
                                onClick={() => { setEditingStagedId(item.id); setEditStagedData(null); }}
                                className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteStagedItem(item.id)}
                                className={`p-2 rounded-lg ${isDark ? 'hover:bg-red-900/30 text-red-400' : 'hover:bg-red-50 text-red-500'}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                          <span className={`text-xs mt-2 inline-block px-2 py-0.5 rounded-full ${getConfidenceColor(d.confidence ?? 0)}`}>
                            {Math.round((d.confidence ?? 0) * 100)}%
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {item.itemType === 'QA_PAIR' && (
                    <div className="p-4">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input
                            className={`w-full px-3 py-2 border rounded-lg text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'border-gray-300'}`}
                            value={editStagedData?.question ?? d.question}
                            onChange={e => setEditStagedData((prev: any) => ({ ...(prev ?? d), question: e.target.value }))}
                            placeholder="Вопрос"
                          />
                          <textarea
                            rows={4}
                            className={`w-full px-3 py-2 border rounded-lg text-sm resize-none ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'border-gray-300'}`}
                            value={editStagedData?.answer ?? d.answer}
                            onChange={e => setEditStagedData((prev: any) => ({ ...(prev ?? d), answer: e.target.value }))}
                            placeholder="Ответ"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleUpdateStagedItem(item.id, { ...d, ...(editStagedData ?? {}) })}
                              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium"
                            >
                              Сохранить
                            </button>
                            <button
                              onClick={() => { setEditingStagedId(null); setEditStagedData(null); }}
                              className={`px-4 py-2 rounded-lg text-sm border ${isDark ? 'border-gray-600 text-gray-300' : 'border-gray-300 text-gray-600'}`}
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className={`font-medium text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>{d.question}</p>
                            <p className={`text-sm mt-1 line-clamp-3 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{d.answer}</p>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              onClick={() => { setEditingStagedId(item.id); setEditStagedData(null); }}
                              className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteStagedItem(item.id)}
                              className={`p-2 rounded-lg ${isDark ? 'hover:bg-red-900/30 text-red-400' : 'hover:bg-red-50 text-red-500'}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {item.itemType === 'CHUNK' && (
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-medium mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            Чанк #{d.index ?? '—'} · {d.metadata?.startChar ?? 0}–{d.metadata?.endChar ?? 0} символов
                          </p>
                          <p className={`text-sm line-clamp-4 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{d.content}</p>
                        </div>
                        <button
                          onClick={() => handleDeleteStagedItem(item.id)}
                          className={`p-2 rounded-lg flex-shrink-0 ${isDark ? 'hover:bg-red-900/30 text-red-400' : 'hover:bg-red-50 text-red-500'}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer: commit button */}
          <div className={`fixed bottom-0 left-0 right-0 p-4 border-t ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
            <button
              onClick={async () => {
                setReviewingDoc(null);
                await handleCommitDocument();
              }}
              disabled={loading || totalActive === 0}
              className="w-full py-3 bg-green-600 text-white rounded-xl font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <DatabaseIcon className="w-5 h-5" />
              {loading ? 'Сохраняем...' : `Сохранить ${totalActive} элементов в базу знаний`}
            </button>
          </div>
        </div>
      </ThemeContext.Provider>
    );
  }

  // ======== DOCUMENT PROCESSING SCREEN ========
  if (processingDocId) {
    return (
      <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
        <div className={`min-h-screen flex flex-col ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
          <div className={`border-b px-4 py-3 flex items-center gap-3 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            <button onClick={() => { eventSourceRef.current?.close(); eventSourceRef.current = null; setProcessingDocId(null); loadDocuments(); }} className="p-1">
              <ChevronLeft className={`w-5 h-5 ${isDark ? 'text-white' : 'text-gray-900'}`} />
            </button>
            <div className="flex-1 min-w-0">
              <h2 className={`font-semibold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>Обработка</h2>
              <p className={`text-xs truncate ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{processingDocTitle}</p>
            </div>
          </div>

          <div className="flex-1 p-4 overflow-y-auto">
            <div className={`rounded-xl p-4 font-mono text-xs space-y-1 min-h-[200px] ${isDark ? 'bg-gray-800 text-gray-300' : 'bg-white text-gray-700'} shadow-sm`}>
              {processingLog.map((line, i) => (
                <div key={i} className={line.startsWith('\n') ? 'mt-3 font-semibold' : ''}>{line.replace(/^\n/, '')}</div>
              ))}
              {!processingDone && !processingErr && (
                <div className="flex items-center gap-2 mt-2 text-blue-500">
                  <div className="animate-spin w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full" />
                  <span>Обрабатываем...</span>
                </div>
              )}
            </div>

            {processingErr && (
              <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-xl text-sm space-y-2">
                <p>❌ {processingErr.replace('__DLQ__', '')}</p>
                {processingErr.startsWith('__DLQ__') ? (
                  <p className="text-xs opacity-80 font-medium">⛔ Документ исчерпал попытки и перемещён в DLQ. Нажмите «Реанимировать» в списке документов.</p>
                ) : (
                  <p className="text-xs opacity-80">Попытка не удалась. Вы можете попробовать снова.</p>
                )}
              </div>
            )}
          </div>

          {processingDone && (
            <div className="p-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
              <button
                onClick={() => loadStagedItems(processingDocId!, processingDocTitle)}
                disabled={stagedLoading}
                className="w-full py-3 bg-blue-600 text-white rounded-xl font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Edit3 className="w-5 h-5" />
                {stagedLoading ? 'Загружаем...' : 'Просмотреть и редактировать'}
              </button>
              <button
                onClick={handleCommitDocument}
                disabled={loading}
                className="w-full py-2 bg-green-600 text-white rounded-xl font-medium disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
              >
                <DatabaseIcon className="w-4 h-4" />
                {loading ? 'Сохраняем...' : 'Сохранить без проверки'}
              </button>
              <button
                onClick={async () => {
                  if (!confirm('Отменить обработку и удалить все извлечённые данные? Документ останется в списке.')) return;
                  const res = await fetch('/api/telegram/mini-app', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ initData: initData || 'dev', action: 'discardStaged', documentId: processingDocId }),
                  });
                  if (res.ok) {
                    setProcessingDocId(null);
                    setProcessingDone(false);
                    await loadDocuments();
                  }
                }}
                className={`w-full py-2 rounded-xl font-medium text-sm flex items-center justify-center gap-2 border ${isDark ? 'border-gray-600 text-gray-400 hover:bg-gray-700' : 'border-gray-300 text-gray-500 hover:bg-gray-50'}`}
              >
                <X className="w-4 h-4" />
                Отменить и удалить результаты
              </button>
            </div>
          )}
        </div>
      </ThemeContext.Provider>
    );
  }

  // ======== ADD RULE SCREEN ========
  if (addingRule) {
    return (
      <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
        <div className={`min-h-screen flex flex-col ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
          <div className={`border-b px-4 py-3 flex items-center gap-3 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            <button onClick={() => setAddingRule(false)} className="p-1">
              <ChevronLeft className={`w-5 h-5 ${isDark ? 'text-white' : 'text-gray-900'}`} />
            </button>
            <h2 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>Новое правило</h2>
          </div>

          <div className="flex-1 p-4 space-y-4 overflow-y-auto pb-32">
            <div className={`rounded-xl p-4 shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
              <label className={`text-sm font-medium mb-2 block ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                Заголовок правила *
              </label>
              <input
                type="text"
                value={newRuleTitle}
                onChange={(e) => setNewRuleTitle(e.target.value)}
                placeholder="Краткое название правила"
                className={`w-full px-3 py-2 border rounded-lg ${isDark ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500' : 'border-gray-300'}`}
              />
            </div>

            <div className={`rounded-xl p-4 shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
              <label className={`text-sm font-medium mb-2 block ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                Описание *
              </label>
              <textarea
                value={newRuleBody}
                onChange={(e) => setNewRuleBody(e.target.value)}
                placeholder="Подробное описание правила..."
                rows={8}
                className={`w-full px-3 py-2 border rounded-lg resize-none ${isDark ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500' : 'border-gray-300'}`}
              />
            </div>

            {actionMsg && (
              <div className={`p-3 rounded-xl text-sm ${
                actionMsg.includes('создано') || actionMsg.includes('✅')
                  ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                  : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
              }`}>
                {actionMsg}
              </div>
            )}
          </div>

          <div className="fixed bottom-0 left-0 right-0 p-4 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <div className="flex gap-2">
              <button
                onClick={() => setAddingRule(false)}
                className={`px-4 py-3 border rounded-xl ${isDark ? 'border-gray-600 text-gray-300' : 'border-gray-300 text-gray-700'}`}
              >
                <X className="w-5 h-5" />
              </button>
              <button
                onClick={handleAddRule}
                disabled={loading || !newRuleTitle.trim() || !newRuleBody.trim()}
                className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Save className="w-4 h-4" />
                {loading ? 'Создаём...' : 'Создать правило'}
              </button>
            </div>
          </div>
        </div>
      </ThemeContext.Provider>
    );
  }

  // Document viewer overlay
  if (docViewer) {
    const { title, text, quote } = docViewer;
    // Split text at the quote to highlight it
    let before = text, highlighted = '', after = '';
    if (quote) {
      const idx = text.indexOf(quote);
      if (idx !== -1) {
        before = text.slice(0, idx);
        highlighted = text.slice(idx, idx + quote.length);
        after = text.slice(idx + quote.length);
      }
    }
    return (
      <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
        <div className={`min-h-screen flex flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
          {/* Header */}
          <div className={`sticky top-0 border-b px-4 py-3 flex items-center gap-3 z-10 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            <button onClick={() => setDocViewer(null)} className="text-blue-600 font-medium flex items-center gap-1">
              <ChevronLeft className="w-5 h-5" />
              Назад
            </button>
            <span className={`font-semibold truncate flex-1 text-sm ${isDark ? 'text-white' : 'text-gray-800'}`}>{title}</span>
          </div>
          {/* Document text */}
          <div className="flex-1 overflow-auto p-4">
            <div className={`rounded-xl p-4 text-sm whitespace-pre-wrap leading-relaxed font-mono ${isDark ? 'bg-gray-800 text-gray-200' : 'bg-white text-gray-800'}`}>
              {highlighted ? (
                <>
                  <span>{before}</span>
                  <span
                    id="doc-highlight"
                    className="bg-yellow-300 dark:bg-yellow-600 text-gray-900 dark:text-white px-0.5 rounded"
                  >
                    {highlighted}
                  </span>
                  <span>{after}</span>
                </>
              ) : (
                <span>{text}</span>
              )}
            </div>
          </div>
        </div>
      </ThemeContext.Provider>
    );
  }

  // Rule detail view
  if (selectedRule) {
    return (
      <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
        <div className={`min-h-screen ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
          {/* Header */}
          <div className={`sticky top-0 border-b px-4 py-3 flex items-center gap-3 z-10 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            <button
              onClick={() => setSelectedRule(null)}
              className="text-blue-600 font-medium flex items-center gap-1"
            >
              <ChevronLeft className="w-5 h-5" />
              Назад
            </button>
            <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-800'}`}>{selectedRule.ruleCode}</span>
            
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => toggleFavorite(selectedRule.id)}
                className={`p-2 rounded-lg transition-colors ${
                  isFavorited 
                    ? 'text-red-500 bg-red-50 dark:bg-red-900/20' 
                    : 'text-gray-400 hover:text-red-500'
                }`}
              >
                <Heart className={`w-5 h-5 ${isFavorited ? 'fill-current' : ''}`} />
              </button>
              <button
                onClick={() => shareRule(selectedRule)}
                className="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg"
              >
                <Share2 className="w-5 h-5" />
              </button>
              
              {isAdmin && !editingRule && (
                <>
                  {selectedRule.confidence < 1.0 && (
                    <button
                      onClick={() => handleConfirmRule(selectedRule.id)}
                      title="Подтвердить правило (100%)"
                      className="p-2 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg"
                    >
                      <CheckCircle className="w-5 h-5" />
                    </button>
                  )}
                  <button
                    onClick={() => setEditingRule(true)}
                    title="Редактировать"
                    className="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg"
                  >
                    <Edit3 className="w-5 h-5" />
                  </button>
                  <button
                    onClick={() => handleDeleteRule(selectedRule.id)}
                    title="Удалить правило"
                    className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="p-4 space-y-4 pb-32">
            {/* Title Card */}
            <div className={`rounded-xl p-4 shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
              {editingRule ? (
                <div className="space-y-3">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg font-bold ${isDark ? 'bg-gray-700 border-gray-600 text-white' : ''}`}
                  />
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg min-h-[200px] ${isDark ? 'bg-gray-700 border-gray-600 text-white' : ''}`}
                  />
                  {actionMsg && (
                    <div className={`p-2 rounded-lg text-sm ${actionMsg.includes('обновлен') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                      {actionMsg}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={handleEditRuleSave}
                      disabled={loading}
                      className="flex-1 bg-blue-600 text-white py-2 rounded-lg font-medium disabled:opacity-50"
                    >
                      <Save className="w-4 h-4 inline mr-2" />
                      {loading ? 'Сохраняем...' : 'Сохранить'}
                    </button>
                    <button onClick={() => { setEditingRule(false); setActionMsg(null); }} className="px-4 py-2 border rounded-lg">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h1 className={`text-lg font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>{selectedRule.title}</h1>
                  {selectedRule.document?.id ? (
                    <button
                      onClick={() => openDocument(selectedRule.document!.id!, selectedRule.sourceSpan?.quote)}
                      className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg mb-2 text-sm transition-colors ${
                        isDark ? 'bg-gray-700 hover:bg-gray-600 text-blue-400' : 'bg-blue-50 hover:bg-blue-100 text-blue-700'
                      }`}
                    >
                      <FileText className="w-4 h-4 shrink-0" />
                      <span className="truncate">{selectedRule.document.title}</span>
                      <ChevronRight className="w-4 h-4 ml-auto shrink-0 opacity-60" />
                    </button>
                  ) : selectedRule.sourceSpan?.locationHint ? (
                    <div className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg mb-2 text-sm ${
                      isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500'
                    }`}>
                      <FileText className="w-4 h-4 shrink-0 opacity-50" />
                      <span className="truncate">Источник: {selectedRule.sourceSpan.locationHint}</span>
                      <span className="ml-auto text-xs opacity-60">документ не привязан</span>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <span className={`px-2 py-1 rounded-full font-medium ${getConfidenceColor(selectedRule.confidence)}`}>
                      {Math.round(selectedRule.confidence * 100)}%
                    </span>
                    {selectedRule._count && (
                      <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>
                        <Heart className="w-3 h-3 inline mr-1" />
                        {selectedRule._count.favorites}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Body */}
            {!editingRule && (
              <div className={`rounded-xl p-4 shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
                <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Описание
                </h2>
                <p className={`whitespace-pre-wrap leading-relaxed ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                  {selectedRule.body}
                </p>
              </div>
            )}

            {/* Domains */}
            {selectedRule.domains && selectedRule.domains.length > 0 && (
              <div className={`rounded-xl p-4 shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
                <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Домены
                </h2>
                <div className="flex flex-wrap gap-2">
                  {selectedRule.domains.map((d) => (
                    <span key={d.domain.slug} className="px-3 py-1 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded-full text-sm">
                      {d.domain.title}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* QA Pairs */}
            {selectedRule.qaPairs && selectedRule.qaPairs.length > 0 && (
              <div className={`rounded-xl p-4 shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
                <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  Связанные вопросы ({selectedRule.qaPairs.length})
                </h2>
                <div className="space-y-3">
                  {selectedRule.qaPairs.map((qa) => (
                    <div key={qa.id} className="border-l-4 border-blue-400 pl-3 py-1">
                      <p className={`font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{qa.question}</p>
                      <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{qa.answer}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comments Section */}
            <div className={`rounded-xl p-4 shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
              <h2 className={`text-sm font-semibold mb-3 uppercase tracking-wide ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                <MessageSquare className="w-4 h-4 inline mr-1" />
                Комментарии ({comments.length})
              </h2>
              
              {/* Add comment */}
              <div className="mb-4 space-y-2">
                {replyTo && (
                  <div className="text-sm text-blue-600 flex items-center gap-1">
                    <Reply className="w-3 h-3" />
                    Ответ на комментарий
                    <button onClick={() => setReplyTo(null)} className="text-gray-400">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addComment()}
                    placeholder="Написать комментарий..."
                    className={`flex-1 px-3 py-2 border rounded-lg ${isDark ? 'bg-gray-700 border-gray-600 text-white' : ''}`}
                  />
                  <button
                    onClick={addComment}
                    disabled={!newComment.trim()}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Comments list */}
              <div className="space-y-3">
                {comments.map((comment) => (
                  <div key={comment.id} className={`p-3 rounded-lg ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
                    <div className="flex items-start justify-between">
                      <div>
                        <p className={`font-medium text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                          Пользователь {comment.telegramId.slice(-4)}
                        </p>
                        <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                          {new Date(comment.createdAt).toLocaleString('ru-RU')}
                        </p>
                      </div>
                      <button
                        onClick={() => setReplyTo(comment.id)}
                        className="text-blue-600 text-sm"
                      >
                        Ответить
                      </button>
                    </div>
                    <p className={`mt-2 ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{comment.content}</p>
                    
                    {/* Replies */}
                    {comment.replies && comment.replies.length > 0 && (
                      <div className="mt-3 ml-4 space-y-2">
                        {comment.replies.map((reply) => (
                          <div key={reply.id} className={`p-2 rounded ${isDark ? 'bg-gray-600' : 'bg-gray-100'}`}>
                            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                              {new Date(reply.createdAt).toLocaleString('ru-RU')}
                            </p>
                            <p className={`text-sm ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>{reply.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ThemeContext.Provider>
    );
  }

  // Main view
  return (
    <ThemeContext.Provider value={{ theme, isDark, setTheme }}>
      <div className={`min-h-screen ${isDark ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
        {/* Header */}
        <div className={`border-b px-4 py-4 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
          <div className="flex items-center justify-between">
            <div>
              <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                👋 Привет{user?.first_name ? `, ${user.first_name}` : ''}!
              </h1>
              <p className={`mt-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                База знаний Аврора
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!isOnline && (
                <span title="Офлайн режим">
                  <WifiOff className="w-5 h-5 text-orange-500" />
                </span>
              )}
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`p-2 rounded-lg ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
              >
                <Settings className={`w-5 h-5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`} />
              </button>
              {isAdmin && (
                <>
                  <button
                    onClick={() => { setAddingRule(true); setActionMsg(null); setNewRuleTitle(''); setNewRuleBody(''); }}
                    title="Добавить правило"
                    className="p-2 rounded-lg bg-blue-600 text-white"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <span className="px-2 py-1 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded-full text-xs font-medium">
                    {role}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Action feedback banner */}
        {actionMsg && (
          <div className={`px-4 py-2 flex items-center justify-between text-sm ${
            actionMsg.includes('Ошибка') || actionMsg.includes('ошибка')
              ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
              : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
          }`}>
            <span>{actionMsg}</span>
            <button onClick={() => setActionMsg(null)} className="ml-2 opacity-60 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Settings Panel */}
        {showSettings && (
          <div className={`p-4 border-b ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
            <h3 className={`font-semibold mb-3 ${isDark ? 'text-white' : ''}`}>Настройки</h3>
            
            {/* Theme */}
            <div className="mb-4">
              <label className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>Тема</label>
              <div className="flex gap-2 mt-1">
                {[
                  { id: 'light', icon: Sun, label: 'Светлая' },
                  { id: 'dark', icon: Moon, label: 'Тёмная' },
                  { id: 'system', icon: Settings, label: 'Системная' },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setTheme(t.id as any);
                      savePreferences({ theme: t.id as any });
                    }}
                    className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm ${
                      theme === t.id
                        ? 'bg-blue-600 text-white'
                        : isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    <t.icon className="w-4 h-4" />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Cache info */}
            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              <p>Офлайн-кэш: активен</p>
              <p className="text-xs mt-1">
                Данные сохраняются для работы без интернета
              </p>
            </div>
          </div>
        )}

        {/* Search */}
        <div className={`p-4 border-b ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder={isRecording ? `🎤 Запись ${recordingTime}с...` : "Поиск правил..."}
                disabled={isRecording}
                className={`w-full px-4 py-3 rounded-xl border-0 focus:ring-2 focus:ring-blue-500 outline-none pr-10 ${
                  isDark ? 'bg-gray-700 text-white placeholder-gray-400' : 'bg-gray-100'
                }`}
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); setAiAnswer(null); setSearchResults(null); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
            <button
              onClick={isRecording ? stopRecording : startRecording}
              disabled={loading}
              className={`px-4 py-3 rounded-xl font-medium disabled:opacity-50 transition-colors ${
                isRecording 
                  ? 'bg-red-600 text-white animate-pulse' 
                  : isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-700'
              }`}
            >
              {isRecording ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
            <button
              onClick={() => setShowAdvancedSearch(!showAdvancedSearch)}
              className={`px-4 py-3 rounded-xl font-medium ${
                showAdvancedSearch 
                  ? 'bg-blue-600 text-white' 
                  : isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
              }`}
            >
              <Filter className="w-5 h-5" />
            </button>
            <button
              onClick={handleSearch}
              disabled={loading || isRecording}
              className="px-4 py-3 bg-blue-600 text-white rounded-xl font-medium disabled:opacity-50"
            >
              <Search className="w-5 h-5" />
            </button>
          </div>

          {/* Advanced Search Filters */}
          {showAdvancedSearch && (
            <div className={`mt-3 p-3 rounded-xl space-y-3 ${isDark ? 'bg-gray-700' : 'bg-gray-50'}`}>
              {/* Confidence */}
              <div>
                <label className={`text-sm font-medium mb-1 block ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  Уверенность AI
                </label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { id: 'all', label: 'Все' },
                    { id: 'high', label: 'Высокая (90%+)' },
                    { id: 'medium', label: 'Средняя (70-90%)' },
                    { id: 'low', label: 'Низкая (<70%)' },
                  ].map((f) => (
                    <button
                      key={f.id}
                      onClick={() => setConfidenceFilter(f.id as any)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        confidenceFilter === f.id
                          ? 'bg-blue-600 text-white'
                          : isDark ? 'bg-gray-600 text-gray-300' : 'bg-white border text-gray-700'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Domain */}
              <div>
                <label className={`text-sm font-medium mb-1 block ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  Домен
                </label>
                <select
                  value={domainFilter}
                  onChange={(e) => setDomainFilter(e.target.value)}
                  className={`w-full px-3 py-2 rounded-lg ${isDark ? 'bg-gray-600 text-white border-gray-500' : 'bg-white border'}`}
                >
                  <option value="">Все домены</option>
                  {domains.map((d) => (
                    <option key={d.id} value={d.slug}>{d.title}</option>
                  ))}
                </select>
              </div>

              {/* Document */}
              <div>
                <label className={`text-sm font-medium mb-1 block ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  <FileSearch className="w-4 h-4 inline mr-1" />
                  Документ
                </label>
                <select
                  value={documentFilter}
                  onChange={(e) => setDocumentFilter(e.target.value)}
                  className={`w-full px-3 py-2 rounded-lg ${isDark ? 'bg-gray-600 text-white border-gray-500' : 'bg-white border'}`}
                >
                  <option value="">Все документы</option>
                  {documents.map((d) => (
                    <option key={d.id} value={d.title}>{d.title}</option>
                  ))}
                </select>
              </div>

              {/* Date Range */}
              <div>
                <label className={`text-sm font-medium mb-1 block ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                  <Calendar className="w-4 h-4 inline mr-1" />
                  Период
                </label>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className={`flex-1 px-3 py-2 rounded-lg ${isDark ? 'bg-gray-600 text-white border-gray-500' : 'bg-white border'}`}
                    placeholder="От"
                  />
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className={`flex-1 px-3 py-2 rounded-lg ${isDark ? 'bg-gray-600 text-white border-gray-500' : 'bg-white border'}`}
                    placeholder="До"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className={`flex border-b overflow-x-auto ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white'}`}>
          {[
            { id: 'search', label: 'Поиск', icon: Search },
            { id: 'favorites', label: 'Избранное', icon: Heart },
            { id: 'rules', label: 'Правила', icon: BookOpen },
            { id: 'pairs', label: 'Пары', icon: MessageCircle },
            { id: 'recent', label: 'Новые', icon: FileText },
            { id: 'history', label: 'История', icon: History },
            { id: 'stats', label: 'Статистика', icon: BarChart3 },
            { id: 'documents', label: 'Документы', icon: FolderOpen },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id as any);
                if (tab.id === 'history') loadInitialData();
                if (tab.id === 'stats') loadStats();
                if (tab.id === 'favorites') loadInitialData();
                if (tab.id === 'documents' && isAdmin) loadDocuments();
                if (tab.id === 'rules') loadAllRules();
                if (tab.id === 'pairs') loadAllPairs();
              }}
              className={`flex items-center justify-center gap-2 py-3 px-4 font-medium text-sm whitespace-nowrap ${
                activeTab === tab.id
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : isDark ? 'text-gray-400' : 'text-gray-600'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
              {tab.id === 'favorites' && favorites.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full">
                  {favorites.length}
                </span>
              )}
            </button>
          ))}
          
          {/* Notifications tab with badge */}
          <button
            onClick={() => {
              setActiveTab('notifications');
              markNotificationsRead();
            }}
            className={`flex items-center justify-center gap-2 py-3 px-4 font-medium text-sm whitespace-nowrap relative ${
              activeTab === 'notifications'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : isDark ? 'text-gray-400' : 'text-gray-600'
            }`}
          >
            <Bell className="w-4 h-4" />
            Уведомления
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                {unreadCount}
              </span>
            )}
          </button>
        </div>

        {/* Content */}
        <div className="p-4 pb-24">
          {loading && (
            <div className="text-center py-8 text-gray-500">
              <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-2" />
              Загрузка...
            </div>
          )}

          {/* AI Answer block */}
          {activeTab === 'search' && (aiLoading || aiAnswer) && (
            <div className={`rounded-xl p-4 shadow-sm border ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-blue-50 border-blue-100'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-blue-600 font-semibold text-sm">✦ Ответ на основе базы знаний</span>
                {aiLoading && <div className="animate-spin w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full" />}
              </div>
              {aiLoading && !aiAnswer && (
                <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Анализирую документы...</p>
              )}
              {/* Clarification question with option buttons */}
              {aiAnswer?.clarificationQuestion && (
                <div className="space-y-3">
                  <p className={`text-sm font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                    {aiAnswer.clarificationQuestion.question}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {aiAnswer.clarificationQuestion.options.map((option) => (
                      <button
                        key={option}
                        onClick={() => handleClarificationAnswer(option)}
                        className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                          isDark
                            ? 'bg-gray-700 border-gray-600 text-blue-400 hover:bg-blue-900/30 hover:border-blue-500'
                            : 'bg-white border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-400'
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Scenario badge — tells user which procedure this answer is scoped to */}
              {aiAnswer?.scenarioLabel && !aiAnswer.clarificationQuestion && (
                <div className={`text-xs mb-2 inline-flex items-center gap-1 px-2 py-1 rounded ${
                  isDark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-100 text-blue-700'
                }`}>
                  <span>✦</span>
                  <span>Ответ для: <b>{aiAnswer.scenarioLabel}</b></span>
                </div>
              )}
              {/* Main answer text */}
              {aiAnswer?.answer && !aiAnswer.clarificationQuestion && (
                <div className={`text-sm whitespace-pre-wrap leading-relaxed ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                  {aiAnswer.answer}
                </div>
              )}
              {/* Supplementary sources */}
              {aiAnswer?.supplementarySources && aiAnswer.supplementarySources.length > 0 && !aiAnswer.clarificationQuestion && (
                <>
                  <div className={`my-3 border-t ${isDark ? 'border-gray-600' : 'border-blue-200'}`} />
                  <p className={`text-xs mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Дополнительные источники:</p>
                  <div className="space-y-2">
                    {aiAnswer.supplementarySources.map((src) => (
                      <button
                        key={src.documentId}
                        onClick={() => openDocument(src.documentId, src.chunkContent)}
                        className={`w-full text-left rounded-lg p-2 border text-xs transition-colors ${
                          isDark
                            ? 'bg-gray-700/50 border-gray-600 hover:bg-gray-700 text-gray-300'
                            : 'bg-white border-blue-100 hover:bg-blue-50 text-gray-600'
                        }`}
                      >
                        <div className="font-medium text-blue-500 truncate">{src.documentTitle}</div>
                        <div className={`mt-0.5 line-clamp-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                          {src.chunkContent}
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {/* Primary source link */}
              {aiAnswer?.primarySource && !aiAnswer.clarificationQuestion && (
                <div className={`mt-2 pt-2 border-t ${isDark ? 'border-gray-700' : 'border-blue-100'}`}>
                  <button
                    onClick={() => openDocument(aiAnswer.primarySource!.documentId, aiAnswer.primarySource!.chunkContent)}
                    className={`text-xs flex items-center gap-1 ${isDark ? 'text-gray-500 hover:text-blue-400' : 'text-gray-400 hover:text-blue-600'}`}
                  >
                    <span>📄</span>
                    <span className="truncate">Источник: {aiAnswer.primarySource.documentTitle}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Search Results */}
          {activeTab === 'search' && searchResults && !loading && (
            <div className="space-y-4">
              {searchResults.rules.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <AlertCircle className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>Ничего не найдено</p>
                </div>
              ) : (
                <>
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    Найдено: <span className="font-semibold">{searchResults.total}</span>
                  </p>
                  <div className="space-y-2">
                    {searchResults.rules.map((rule) => {
                      const conf = getConfidenceBadge(rule.confidence);
                      return (
                        <button
                          key={rule.id}
                          onClick={() => handleRuleClick(rule)}
                          className={`w-full text-left p-4 rounded-xl shadow-sm hover:shadow-md transition-shadow ${
                            isDark ? 'bg-gray-800' : 'bg-white'
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-blue-600 font-bold">{rule.ruleCode}</span>
                                <span className={`px-2 py-0.5 rounded-full text-xs ${conf.color}`}>
                                  {conf.text}
                                </span>
                              </div>
                              <h4 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{rule.title}</h4>
                              {rule.document && (
                                <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                  📄 {rule.document.title}
                                </p>
                              )}
                              <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                                {(rule._count?.comments || 0) > 0 && (
                                  <span className="flex items-center gap-1">
                                    <MessageSquare className="w-3 h-3" />
                                    {rule._count?.comments}
                                  </span>
                                )}
                                {(rule._count?.favorites || 0) > 0 && (
                                  <span className="flex items-center gap-1">
                                    <Heart className="w-3 h-3" />
                                    {rule._count?.favorites}
                                  </span>
                                )}
                              </div>
                            </div>
                            <ChevronRight className={`w-5 h-5 flex-shrink-0 ${isDark ? 'text-gray-600' : 'text-gray-400'}`} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Favorites */}
          {activeTab === 'favorites' && !loading && (
            <div className="space-y-2">
              {favorites.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Heart className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>Нет избранных правил</p>
                  <p className="text-sm mt-1">Нажмите ❤️ на карточке правила</p>
                </div>
              ) : (
                favorites.map((fav) => (
                  <button
                    key={fav.id}
                    onClick={() => handleRuleClick(fav.rule)}
                    className={`w-full text-left p-4 rounded-xl shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-blue-600 font-bold">{fav.rule.ruleCode}</span>
                        <h4 className={`font-medium mt-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{fav.rule.title}</h4>
                        {fav.notes && (
                          <p className={`text-sm mt-1 italic ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            📝 {fav.notes}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(fav.rule.id);
                        }}
                        className="text-red-500 p-2"
                      >
                        <Heart className="w-5 h-5 fill-current" />
                      </button>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* Notifications */}
          {activeTab === 'notifications' && !loading && (
            <div className="space-y-2">
              {notifications.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Bell className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>Нет уведомлений</p>
                </div>
              ) : (
                notifications.map((notif) => (
                  <div
                    key={notif.id}
                    onClick={() => notif.ruleId && handleRuleClick({ id: notif.ruleId } as Rule)}
                    className={`p-4 rounded-xl cursor-pointer ${
                      notif.isRead 
                        ? isDark ? 'bg-gray-800' : 'bg-white' 
                        : 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {!notif.isRead && <div className="w-2 h-2 bg-blue-600 rounded-full mt-2 flex-shrink-0" />}
                      <div className="flex-1">
                        <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{notif.title}</p>
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{notif.message}</p>
                        <p className="text-xs text-gray-400 mt-1">
                          {new Date(notif.sentAt).toLocaleString('ru-RU')}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Rules tab */}
          {activeTab === 'rules' && (
            <div className="space-y-2">
              <div className={`text-xs px-1 pb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Всего правил: {allRulesTotal}
              </div>
              {loading && allRules.length === 0 && (
                <div className="text-center py-12 text-gray-400">Загрузка...</div>
              )}
              {!loading && allRules.length === 0 && (
                <div className="text-center py-12 text-gray-400">Правила не найдены</div>
              )}
              {allRules.map((rule) => (
                <div
                  key={rule.id}
                  onClick={() => handleRuleClick(rule)}
                  className={`p-4 rounded-xl shadow-sm cursor-pointer hover:shadow-md transition-shadow ${isDark ? 'bg-gray-800' : 'bg-white'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-blue-600 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded">
                          {rule.ruleCode}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          (rule.confidence ?? 0) >= 0.9
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : (rule.confidence ?? 0) >= 0.7
                              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {Math.round((rule.confidence ?? 0) * 100)}%
                        </span>
                      </div>
                      <p className={`text-sm font-medium leading-snug ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {rule.title}
                      </p>
                      {rule.document?.title && (
                        <p className={`text-xs mt-1 truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                          {rule.document.title}
                        </p>
                      )}
                    </div>
                    <ChevronRight className={`w-4 h-4 flex-shrink-0 mt-1 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} />
                  </div>
                </div>
              ))}
              {allRules.length > 0 && allRules.length < allRulesTotal && (
                <button
                  onClick={() => loadAllRules(allRules[allRules.length - 1].id)}
                  disabled={loading}
                  className="w-full py-3 text-sm text-blue-600 font-medium"
                >
                  {loading ? 'Загрузка...' : `Загрузить ещё (${allRulesTotal - allRules.length})`}
                </button>
              )}
            </div>
          )}

          {/* Pairs tab */}
          {activeTab === 'pairs' && (
            <div className="space-y-2">
              <div className={`text-xs px-1 pb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Всего пар: {allPairsTotal}
              </div>
              {loading && allPairs.length === 0 && (
                <div className="text-center py-12 text-gray-400">Загрузка...</div>
              )}
              {!loading && allPairs.length === 0 && (
                <div className="text-center py-12 text-gray-400">Пары не найдены</div>
              )}
              {allPairs.map((pair) => (
                <div
                  key={pair.id}
                  className={`p-4 rounded-xl shadow-sm ${isDark ? 'bg-gray-800' : 'bg-white'}`}
                >
                  <p className={`text-sm font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {pair.question}
                  </p>
                  <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    {pair.answer}
                  </p>
                  {(pair.rule?.ruleCode || pair.document?.title) && (
                    <div className="flex items-center gap-2 mt-2">
                      {pair.rule?.ruleCode && (
                        <span className="text-xs font-mono text-blue-600 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded">
                          {pair.rule.ruleCode}
                        </span>
                      )}
                      {pair.document?.title && (
                        <span className={`text-xs truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                          {pair.document.title}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {allPairs.length > 0 && allPairs.length < allPairsTotal && (
                <button
                  onClick={() => loadAllPairs(allPairs[allPairs.length - 1].id)}
                  disabled={loading}
                  className="w-full py-3 text-sm text-blue-600 font-medium"
                >
                  {loading ? 'Загрузка...' : `Загрузить ещё (${allPairsTotal - allPairs.length})`}
                </button>
              )}
            </div>
          )}

          {/* Documents tab */}
          {activeTab === 'documents' && !isAdmin && (
            <div className="text-center py-16">
              <FolderOpen className={`w-16 h-16 mx-auto mb-4 opacity-30 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
              <p className={`text-lg font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>Требуется доступ администратора</p>
              <p className={`text-sm mt-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Откройте приложение через Telegram с учётной записью администратора</p>
            </div>
          )}
          {activeTab === 'documents' && isAdmin && (
            <div className="space-y-4">
              {/* Hidden file input (SUPER_ADMIN only) */}
              {role === 'SUPER_ADMIN' && (
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.txt"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              )}

              {/* Upload button — SUPER_ADMIN only */}
              {role === 'SUPER_ADMIN' && (
                <>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={docUploading}
                    className="w-full flex items-center justify-center gap-3 py-4 rounded-xl bg-blue-600 text-white font-medium disabled:opacity-50"
                  >
                    <Upload className="w-5 h-5" />
                    {docUploading ? 'Загружается...' : 'Загрузить документ'}
                  </button>

                  {docUploading && (
                    <div className="flex items-center justify-center gap-2 py-2 text-blue-600">
                      <div className="animate-spin w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full" />
                      <span className="text-sm">Читаем и сохраняем документ...</span>
                    </div>
                  )}

                  {docUploadMessage && (
                    <div className={`p-3 rounded-xl text-sm ${
                      docUploadMessage.includes('загружен') || docUploadMessage.includes('успешно')
                        ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                        : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                    }`}>
                      {docUploadMessage}
                    </div>
                  )}

                  <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    Поддерживаются: PDF, DOCX, DOC, TXT. После загрузки нажмите ▶ для запуска обработки AI.
                  </p>
                </>
              )}

              {/* Document list */}
              <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Все документы ({docList.length})
              </h3>
              {docList.length === 0 ? (
                <div className={`text-center py-8 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>Документы не найдены</p>
                </div>
              ) : (
                docList.map((doc) => (
                  <div
                    key={doc.id}
                    onClick={() => openDocument(doc.id)}
                    className={`p-4 rounded-xl cursor-pointer transition-shadow hover:shadow-md ${isDark ? 'bg-gray-800 hover:bg-gray-750' : 'bg-white hover:bg-gray-50'} shadow-sm`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className={`font-medium truncate ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                          {doc.title}
                        </p>
                        <p className={`text-xs truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                          {doc.filename}
                        </p>
                        <div className="flex gap-3 mt-1 text-xs text-gray-400 flex-wrap">
                          <button
                            onClick={(e) => { e.stopPropagation(); loadDocumentKnowledge(doc); }}
                            className="text-blue-600 underline font-medium"
                          >
                            {doc._count?.rules ?? 0} правил
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); loadDocumentKnowledge(doc, 'pairs'); }}
                            className="text-blue-600 underline font-medium"
                          >
                            {doc._count?.qaPairs ?? 0} вопросов
                          </button>
                          <span>{new Date(doc.uploadedAt).toLocaleDateString('ru-RU')}</span>
                        </div>
                        {doc.parseError && doc.parseStatus !== 'DEAD' && (
                          <p className="text-xs text-red-500 mt-1 truncate">{doc.parseError.slice(0, 80)}</p>
                        )}
                        {doc.parseStatus === 'DEAD' && (
                          <p className="text-xs text-red-600 font-medium mt-1">
                            ⛔ Исчерпаны попытки ({doc.retryCount ?? 3}/3)
                          </p>
                        )}
                        {doc.parseStatus === 'FAILED' && (doc.retryCount ?? 0) > 0 && (
                          <p className="text-xs text-orange-500 mt-1">
                            Попытка {doc.retryCount}/3
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 flex-shrink-0">
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                          doc.parseStatus === 'COMPLETED'
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : doc.parseStatus === 'PROCESSING'
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : doc.parseStatus === 'FAILED'
                            ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                            : doc.parseStatus === 'DEAD'
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            : doc.parseStatus === 'EXTRACTED'
                            ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {doc.parseStatus === 'COMPLETED' ? '✓ Готов'
                            : doc.parseStatus === 'PROCESSING' ? '⏳ Обработка'
                            : doc.parseStatus === 'FAILED' ? '✗ Ошибка'
                            : doc.parseStatus === 'DEAD' ? '⛔ DLQ'
                            : doc.parseStatus === 'EXTRACTED' ? '📦 Извлечено'
                            : '⏸ Ожидание'}
                        </span>
                        {/* Process button for PENDING/FAILED/EXTRACTED */}
                        {(doc.parseStatus === 'PENDING' || doc.parseStatus === 'FAILED') && (
                          <button
                            onClick={() => handleProcessDocument(doc.id, doc.title)}
                            className="flex items-center gap-1 px-2 py-1 bg-blue-600 text-white text-xs rounded-lg font-medium"
                          >
                            <PlayCircle className="w-3 h-3" />
                            Обработать
                          </button>
                        )}
                        {doc.parseStatus === 'EXTRACTED' && (
                          <button
                            onClick={() => handleProcessDocument(doc.id, doc.title)}
                            className="flex items-center gap-1 px-2 py-1 bg-yellow-600 text-white text-xs rounded-lg font-medium"
                          >
                            <PlayCircle className="w-3 h-3" />
                            Повтор
                          </button>
                        )}
                        {doc.parseStatus === 'DEAD' && (
                          <button
                            onClick={async () => {
                              const res = await fetch('/api/telegram/mini-app', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ initData: initData || 'dev', action: 'reviveDocument', documentId: doc.id }),
                              });
                              const data = await res.json();
                              if (data.success) { setActionMsg('Документ реанимирован'); loadDocuments(); }
                              else setActionMsg(data.error || 'Ошибка');
                            }}
                            className="flex items-center gap-1 px-2 py-1 bg-red-600 text-white text-xs rounded-lg font-medium"
                          >
                            ↺ Реанимировать
                          </button>
                        )}
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`Удалить документ «${doc.title}»? Это также удалит все связанные правила и вопросы.`)) return;
                            const res = await fetch('/api/telegram/mini-app', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ initData: initData || 'dev', action: 'deleteDocument', documentId: doc.id }),
                            });
                            const data = await res.json();
                            if (data.success) { setActionMsg('Документ удалён'); loadDocuments(); }
                            else setActionMsg(data.error || 'Ошибка удаления');
                          }}
                          className="flex items-center gap-1 px-2 py-1 bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400 text-xs rounded-lg font-medium border border-red-200 dark:border-red-800"
                          title="Удалить документ"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Empty state */}
          {!loading && activeTab === 'search' && !searchResults && !isRecording && (
            <div className="text-center py-12 text-gray-500">
              <Search className="w-16 h-16 mx-auto mb-4 opacity-30" />
              <p className="text-lg font-medium">Начните поиск</p>
              <p className="text-sm mt-1">Введите запрос или используйте 🎤</p>
              
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {['Цены', 'Апостиль', 'Нотариус', 'Сроки', 'Доставка'].map((tag) => (
                  <button
                    key={tag}
                    onClick={() => {
                      setSearchQuery(tag);
                      handleSearch();
                    }}
                    className={`px-3 py-1.5 rounded-full text-sm border ${
                      isDark ? 'border-gray-600 text-gray-300 hover:border-blue-400' : 'text-gray-700 hover:border-blue-400'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </ThemeContext.Provider>
  );
}
