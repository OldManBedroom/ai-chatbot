import { NextRequest, NextResponse } from 'next/server';
import { cosineSimilarity } from '@/lib/utils';
import path from 'path';
import { promises as fs } from 'fs';
import OpenAI from 'openai';

// Type for a syllabus chunk
interface SyllabusChunk {
  chunk_id: number;
  text: string;
  embedding: number[];
}

// 1. Install openai: pnpm add openai
// 2. Set OPENAI_API_KEY in your .env file
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Replace the placeholder getEmbedding with a real implementation
async function getEmbedding(text: string): Promise<number[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set in environment');
  }
  const response = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: text,
  });
  return response.data[0].embedding;
}

export async function POST(req: NextRequest) {
  try {
    const { question, topK = 4 } = await req.json();
    if (!question || typeof question !== 'string') {
      return NextResponse.json({ error: 'Missing or invalid question' }, { status: 400 });
    }

    // Load syllabus embeddings
    const filePath = path.join(process.cwd(), 'data', 'cs61a_syllabus_embeddings.json');
    const file = await fs.readFile(filePath, 'utf8');
    const chunks: SyllabusChunk[] = JSON.parse(file);

    // Get embedding for the user question
    let questionEmbedding: number[];
    try {
      questionEmbedding = await getEmbedding(question);
    } catch (e) {
      return NextResponse.json({ error: 'Embedding API not implemented' }, { status: 500 });
    }

    // Compute similarity for each chunk
    const similarities = chunks.map(chunk => ({
      ...chunk,
      similarity: cosineSimilarity(questionEmbedding, chunk.embedding),
    }));

    // Sort by similarity, descending
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topChunks = similarities.slice(0, topK);

    // Combine context
    const context = topChunks.map(c => c.text).join('\n---\n');
    
    // Return just the context, not a full prompt template
    return NextResponse.json({
      topChunks: topChunks.map(({ chunk_id, text, similarity }) => ({ chunk_id, text, similarity })),
      context,
      question,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
