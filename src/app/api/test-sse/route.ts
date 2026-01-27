/**
 * Test SSE endpoint - NO AUTH
 * Used to diagnose if Railway proxy supports SSE correctly
 * 
 * Test in browser: open /api/test-sse and watch for streaming messages
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  console.log('[test-sse] Starting SSE test stream');
  
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        console.log('[test-sse] Stream started');
        
        // Send initial message immediately
        controller.enqueue(encoder.encode(`data: {"type":"start","message":"SSE connection established"}\n\n`));
        
        // Send 10 messages with 2-second intervals
        for (let i = 1; i <= 10; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          const message = {
            type: 'progress',
            count: i,
            timestamp: new Date().toISOString(),
            message: `Message ${i} of 10`
          };
          
          console.log(`[test-sse] Sending message ${i}`);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
        }
        
        // Send completion message
        controller.enqueue(encoder.encode(`data: {"type":"complete","message":"SSE test completed successfully"}\n\n`));
        console.log('[test-sse] Stream completed successfully');
        
      } catch (error) {
        console.error('[test-sse] Stream error:', error);
        controller.enqueue(encoder.encode(`data: {"type":"error","message":"${error}"}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // Additional headers for various proxies
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
