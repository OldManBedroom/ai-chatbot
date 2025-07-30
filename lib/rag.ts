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

// OpenAI client for embeddings
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Get embedding for text
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

// Main RAG function that can be imported and used directly
export async function getRAGContext(question: string, topK: number = 4) {
  try {
    if (!question || typeof question !== 'string') {
      throw new Error('Missing or invalid question');
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
      throw new Error('Failed to get embedding for question');
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
    
    return {
      topChunks: topChunks.map(({ chunk_id, text, similarity }) => ({ chunk_id, text, similarity })),
      context,
      question,
    };
  } catch (err) {
    throw new Error(`RAG processing failed: ${(err as Error).message}`);
  }
} 