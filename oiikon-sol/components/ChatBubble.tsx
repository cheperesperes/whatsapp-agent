import React from 'react';

export type MessageRole = 'user' | 'assistant' | 'system';

interface ChatBubbleProps {
  role: MessageRole;
  content: string;
  timestamp: string;
  handoffDetected?: boolean;
}

export function ChatBubble({
  role,
  content,
  timestamp,
  handoffDetected = false,
}: ChatBubbleProps) {
  if (role === 'system' || handoffDetected) {
    return (
      <div className="flex justify-center mb-4">
        <div className="bg-amber-900/40 border border-amber-700 rounded px-3 py-2 max-w-xs">
          <div className="flex items-start gap-2">
            <span className="text-amber-400 flex-shrink-0 mt-0.5">⚠️</span>
            <div className="flex-1">
              <p className="text-amber-100 text-sm">{content}</p>
              <p className="text-amber-700 text-xs mt-1">{timestamp}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isUser = role === 'user';

  return (
    <div className={`flex mb-4 ${isUser ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-xs px-4 py-2 rounded-lg ${
          isUser
            ? 'bg-slate-700 text-slate-100'
            : 'bg-blue-700 text-blue-50'
        }`}
      >
        <p className="text-sm break-words">{content}</p>
        <p
          className={`text-xs mt-1 ${
            isUser ? 'text-slate-400' : 'text-blue-200'
          }`}
        >
          {timestamp}
        </p>
      </div>
    </div>
  );
}
