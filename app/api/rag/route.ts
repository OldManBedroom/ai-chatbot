import { NextRequest, NextResponse } from 'next/server';
import { getRAGContext } from '@/lib/rag';

export async function POST(req: NextRequest) {
  try {
    const { question, topK = 4 } = await req.json();
    
    const result = await getRAGContext(question, topK);
    
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
