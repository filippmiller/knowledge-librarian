import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkRateLimit, getClientKey, RATE_LIMITS } from '@/lib/rate-limiter';

/**
 * POST /api/feedback
 * Submit feedback for an answer
 */
export async function POST(request: NextRequest) {
  // Rate limiting (use same as ask endpoint)
  const clientKey = getClientKey(request);
  const rateLimitResult = checkRateLimit(clientKey, RATE_LIMITS.askQuestion);

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const {
      messageId,
      question,
      answer,
      rating,
      feedbackType,
      comment,
      suggestedAnswer,
      confidence,
      domainsUsed,
    } = body;

    // Validate required fields
    if (!question || !answer || !rating) {
      return NextResponse.json(
        { error: 'question, answer, and rating are required' },
        { status: 400 }
      );
    }

    // Validate rating
    const validRatings = ['HELPFUL', 'PARTIALLY', 'NOT_HELPFUL', 'INCORRECT'];
    if (!validRatings.includes(rating)) {
      return NextResponse.json(
        { error: `Invalid rating. Must be one of: ${validRatings.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate feedbackType if provided
    const validFeedbackTypes = ['MISSING_INFO', 'WRONG_INFO', 'OUTDATED_INFO', 'UNCLEAR', 'OFF_TOPIC', 'GREAT'];
    if (feedbackType && !validFeedbackTypes.includes(feedbackType)) {
      return NextResponse.json(
        { error: `Invalid feedbackType. Must be one of: ${validFeedbackTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Create feedback record
    const feedback = await prisma.answerFeedback.create({
      data: {
        messageId,
        question,
        answer,
        rating,
        feedbackType,
        comment,
        suggestedAnswer,
        confidence,
        domainsUsed,
      },
    });

    // If feedback indicates incorrect answer, create an AI question for review
    if (rating === 'INCORRECT' || rating === 'NOT_HELPFUL') {
      await prisma.aIQuestion.create({
        data: {
          issueType: 'answer_feedback',
          question: `Пользователь отметил ответ как ${rating === 'INCORRECT' ? 'неверный' : 'бесполезный'}:\n\nВопрос: ${question}\n\nОтвет: ${answer.slice(0, 500)}...`,
          context: {
            feedbackId: feedback.id,
            rating,
            feedbackType,
            comment,
            suggestedAnswer,
          },
          status: 'OPEN',
        },
      });
    }

    return NextResponse.json({
      success: true,
      feedbackId: feedback.id,
      message: 'Спасибо за обратную связь! Это поможет нам улучшить систему.',
    });
  } catch (error) {
    console.error('Error saving feedback:', error);
    return NextResponse.json(
      { error: 'Failed to save feedback' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/feedback
 * Get feedback statistics (admin only - no auth for now for simplicity)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');

    const since = new Date();
    since.setDate(since.getDate() - days);

    // Get feedback counts by rating
    const ratingCounts = await prisma.answerFeedback.groupBy({
      by: ['rating'],
      _count: true,
      where: {
        createdAt: { gte: since },
      },
    });

    // Get feedback counts by type
    const typeCounts = await prisma.answerFeedback.groupBy({
      by: ['feedbackType'],
      _count: true,
      where: {
        createdAt: { gte: since },
        feedbackType: { not: null },
      },
    });

    // Get total count
    const total = await prisma.answerFeedback.count({
      where: {
        createdAt: { gte: since },
      },
    });

    // Get unreviewed count
    const unreviewed = await prisma.answerFeedback.count({
      where: {
        createdAt: { gte: since },
        reviewedAt: null,
        rating: { in: ['NOT_HELPFUL', 'INCORRECT'] },
      },
    });

    // Calculate satisfaction score
    const helpful = ratingCounts.find(r => r.rating === 'HELPFUL')?._count || 0;
    const partial = ratingCounts.find(r => r.rating === 'PARTIALLY')?._count || 0;
    const satisfactionScore = total > 0
      ? Math.round(((helpful + partial * 0.5) / total) * 100)
      : null;

    return NextResponse.json({
      period: { days, since: since.toISOString() },
      summary: {
        total,
        unreviewed,
        satisfactionScore,
      },
      byRating: ratingCounts.reduce((acc, r) => {
        acc[r.rating] = r._count;
        return acc;
      }, {} as Record<string, number>),
      byType: typeCounts.reduce((acc, r) => {
        if (r.feedbackType) acc[r.feedbackType] = r._count;
        return acc;
      }, {} as Record<string, number>),
    });
  } catch (error) {
    console.error('Error getting feedback stats:', error);
    return NextResponse.json(
      { error: 'Failed to get feedback statistics' },
      { status: 500 }
    );
  }
}
