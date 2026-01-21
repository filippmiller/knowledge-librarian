import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { ingestKnowledge } from '@/lib/librarian-service';

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();

    // Validate required fields
    if (!body.title || typeof body.title !== 'string') {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    if (!body.content || typeof body.content !== 'string') {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }
    if (body.title.length > 500) {
      return NextResponse.json({ error: 'title exceeds 500 characters' }, { status: 400 });
    }
    if (body.content.length > 100000) {
      return NextResponse.json({ error: 'content exceeds 100000 characters' }, { status: 400 });
    }

    // Validate entryType if provided
    const validEntryTypes = ['FACT', 'PROCEDURE', 'RULE', 'DEFINITION', 'REFERENCE'];
    if (body.entryType && !validEntryTypes.includes(body.entryType)) {
      return NextResponse.json(
        { error: `Invalid entryType. Must be one of: ${validEntryTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate sourceType if provided
    const validSourceTypes = ['MANUAL', 'AI_EXTRACTED', 'RULE_IMPORT', 'QA_IMPORT', 'AGENT'];
    if (body.sourceType && !validSourceTypes.includes(body.sourceType)) {
      return NextResponse.json(
        { error: `Invalid sourceType. Must be one of: ${validSourceTypes.join(', ')}` },
        { status: 400 }
      );
    }

    const result = await ingestKnowledge({
      title: body.title,
      content: body.content,
      domainSlug: body.domainSlug,
      entryType: body.entryType,
      evidence: body.evidence,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      createdBy: body.createdBy || body.agentId,
      keywords: body.keywords,
      entities: body.entities,
    });

    if (!result.success) {
      const status = result.isDuplicate ? 409 : 400;
      return NextResponse.json(
        {
          error: result.error,
          isDuplicate: result.isDuplicate,
          existingId: result.existingId,
          securityViolations: result.securityViolations,
        },
        { status }
      );
    }

    return NextResponse.json({ success: true, entryId: result.entryId }, { status: 201 });
  } catch (error) {
    console.error('Error ingesting knowledge:', error);
    return NextResponse.json({ error: 'Failed to ingest knowledge' }, { status: 500 });
  }
}
