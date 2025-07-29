import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    console.log('Raw JSON received:', JSON.stringify(json, null, 2));
    requestBody = postRequestBodySchema.parse(json);
    console.log('Request body parsed successfully');
  } catch (error) {
    console.log('Failed to parse request body. Error:', error);
    console.log('Error details:', error instanceof Error ? error.message : 'Unknown error');
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const {
      id,
      message,
      selectedChatModel,
      selectedVisibilityType,
    }: {
      id: string;
      message: ChatMessage;
      selectedChatModel: ChatModel['id'];
      selectedVisibilityType: VisibilityType;
    } = requestBody;

    console.log('Starting chat processing for model:', selectedChatModel);

    const session = await auth();

    if (!session?.user) {
      console.log('No session or user found');
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    console.log('User authenticated:', session.user.id);

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      console.log('Rate limit exceeded');
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chat = await getChatById({ id });

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message,
      });

      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
      console.log('Created new chat with title:', title);
    } else {
      if (chat.userId !== session.user.id) {
        console.log('User not authorized for this chat');
        return new ChatSDKError('forbidden:chat').toResponse();
      }
      console.log('Using existing chat');
    }

    const messagesFromDb = await getMessagesByChatId({ id });
    const uiMessages = [...convertToUIMessages(messagesFromDb), message];

    console.log('Total messages to process:', uiMessages.length);

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    console.log('About to create UIMessageStream');

    // Get RAG context for the user's message
    let ragContext = '';
    try {
      const userMessageText = message.parts
        .filter(part => part.type === 'text')
        .map(part => (part as any).text)
        .join(' ');
      
      console.log('User message text:', userMessageText);
      
      if (userMessageText.trim()) {
        console.log('Calling RAG API with question:', userMessageText);
        
        const ragRes = await fetch(`${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/rag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: userMessageText }),
        });
        
        console.log('RAG API response status:', ragRes.status);
        
        if (ragRes.ok) {
          const ragData = await ragRes.json();
          console.log('RAG API response data:', JSON.stringify(ragData, null, 2));
          
          if (ragData.context) {
            ragContext = `\n\nIMPORTANT: Use the following course information to answer the user's question. If the information is relevant to their question, base your answer on this context:\n\n${ragData.context}\n\nWhen answering, reference specific details from the provided course information when applicable.`;
            console.log('RAG context retrieved and added to system prompt');
            console.log('Context length:', ragData.context.length);
            console.log('Final system prompt with context:', systemPrompt({ selectedChatModel, requestHints }) + ragContext);
          } else {
            console.log('RAG API returned no context');
          }
        } else {
          console.log('RAG API call failed with status:', ragRes.status);
          const errorText = await ragRes.text();
          console.log('RAG API error response:', errorText);
        }
      } else {
        console.log('User message is empty, skipping RAG');
      }
    } catch (error) {
      console.error('RAG API call failed:', error);
    }

    const stream = createUIMessageStream({
      execute: ({ writer: dataStream }) => {
        console.log('Execute function called - starting streamText');
        //console.log('Executing streamText with model:', selectedChatModel);
        console.log('Prompt sent to LLM:', uiMessages.map(m => m.parts.filter(p => p.type === 'text').map(p => (p as any).text).join(' ')).join('\n'));
        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }) + ragContext,
          messages: convertToModelMessages(uiMessages),
          stopWhen: stepCountIs(5),
          experimental_activeTools:
            selectedChatModel === 'chat-model-reasoning'
              ? []
              : [
                  'getWeather',
                  'createDocument',
                  'updateDocument',
                  'requestSuggestions',
                ],
          experimental_transform: smoothStream({ chunking: 'word' }),
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({
              session,
              dataStream,
            }),
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
        });

        result.consumeStream();

        dataStream.merge(
          result.toUIMessageStream({
            sendReasoning: true,
          }),
        );
      },
      generateId: generateUUID,
      onFinish: async ({ messages }) => {
        await saveMessages({
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            parts: message.parts,
            createdAt: new Date(),
            attachments: [],
            chatId: id,
          })),
        });
      },
      onError: () => {
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
    } else {
      return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
