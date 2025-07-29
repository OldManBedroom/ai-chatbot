import { useState, useEffect } from 'react';
import { useScrollToBottom } from './use-scroll-to-bottom';
import type { UseChatHelpers } from '@ai-sdk/react';
import type { ChatMessage } from '@/lib/types';

export function useMessages({
  chatId,
  status,
}: {
  chatId: string;
  status: UseChatHelpers<ChatMessage>['status'];
}) {
  const {
    containerRef,
    endRef,
    isAtBottom,
    scrollToBottom,
    onViewportEnter,
    onViewportLeave,
  } = useScrollToBottom();

  const [hasSentMessage, setHasSentMessage] = useState(false);

  useEffect(() => {
    if (chatId) {
      // Disabled auto-scroll on chat change
      // if (isAtBottom) {
      //   scrollToBottom('instant');
      // }
      setHasSentMessage(false);
    }
  }, [chatId, setHasSentMessage]);

  useEffect(() => {
    if (status === 'submitted') {
      setHasSentMessage(true);
      // Disabled auto-scroll on message submission
      // if (isAtBottom) {
      //   scrollToBottom('smooth');
      // }
    }
  }, [status, setHasSentMessage]);

  return {
    containerRef,
    endRef,
    isAtBottom,
    scrollToBottom,
    onViewportEnter,
    onViewportLeave,
    hasSentMessage,
  };
}
