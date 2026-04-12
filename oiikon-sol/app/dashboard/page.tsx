'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@/lib/supabase';
import { ChatBubble } from '@/components/ChatBubble';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface Conversation {
  id: string;
  phone_number: string;
  customer_name?: string;
  status: 'active' | 'escalated' | 'closed';
  last_message?: string;
  last_message_timestamp?: string;
  last_message_timestamp_unix?: number;
}

interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  handoff_detected?: boolean;
}

export default function DashboardPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [searchPhone, setSearchPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [messageLoading, setMessageLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationsChannelRef = useRef<RealtimeChannel | null>(null);
  const messagesChannelRef = useRef<RealtimeChannel | null>(null);

  const supabase = createBrowserClient();

  // Scroll to bottom on new messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Fetch conversations
  const fetchConversations = async () => {
    try {
      const { data, error } = await supabase
        .from('conversations')
        .select(`
          id,
          phone_number,
          customer_name,
          status,
          messages(content, created_at)
        `)
        .order('id', { ascending: false });

      if (error) {
        console.error('Error fetching conversations:', error);
        return;
      }

      const conversationsWithLastMessage = (data || []).map((conv: any) => {
        const messages = conv.messages || [];
        const lastMessage = messages[messages.length - 1];

        return {
          id: conv.id,
          phone_number: conv.phone_number,
          customer_name: conv.customer_name,
          status: conv.status,
          last_message: lastMessage?.content?.substring(0, 50) || 'No messages',
          last_message_timestamp: lastMessage?.created_at || '',
          last_message_timestamp_unix: lastMessage ? new Date(lastMessage.created_at).getTime() : 0,
        };
      });

      // Sort by most recent message
      conversationsWithLastMessage.sort((a, b) => b.last_message_timestamp_unix - a.last_message_timestamp_unix);

      setConversations(conversationsWithLastMessage);
      setLoading(false);
    } catch (err) {
      console.error('Error:', err);
      setLoading(false);
    }
  };

  // Fetch messages for selected conversation
  const fetchMessages = async (conversationId: string) => {
    setMessageLoading(true);
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Error fetching messages:', error);
        return;
      }

      setMessages(data || []);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setMessageLoading(false);
    }
  };

  // Subscribe to realtime updates
  useEffect(() => {
    fetchConversations();

    // Subscribe to conversations table changes
    conversationsChannelRef.current = supabase
      .channel('conversations')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        () => {
          fetchConversations();
        }
      )
      .subscribe();

    return () => {
      if (conversationsChannelRef.current) {
        supabase.removeChannel(conversationsChannelRef.current);
      }
    };
  }, []);

  // Subscribe to messages for selected conversation
  useEffect(() => {
    if (!selectedConversation) return;

    fetchMessages(selectedConversation.id);

    // Subscribe to messages table changes for this conversation
    messagesChannelRef.current = supabase
      .channel(`messages-${selectedConversation.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${selectedConversation.id}`,
        },
        (payload) => {
          const newMessage = payload.new as Message;
          setMessages((prev) => [...prev, newMessage]);
        }
      )
      .subscribe();

    return () => {
      if (messagesChannelRef.current) {
        supabase.removeChannel(messagesChannelRef.current);
      }
    };
  }, [selectedConversation?.id]);

  // Filter conversations by search
  const filteredConversations = conversations.filter((conv) =>
    conv.phone_number.includes(searchPhone)
  );

  // Format timestamp
  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-900/40 text-green-400';
      case 'escalated':
        return 'bg-red-900/40 text-red-400';
      case 'closed':
        return 'bg-gray-700/40 text-gray-400';
      default:
        return 'bg-slate-700/40 text-slate-400';
    }
  };

  const handleReturnToAI = async () => {
    if (!selectedConversation) return;

    try {
      const { error } = await supabase
        .from('conversations')
        .update({ status: 'active' })
        .eq('id', selectedConversation.id);

      if (error) {
        console.error('Error updating conversation:', error);
        return;
      }

      setSelectedConversation({
        ...selectedConversation,
        status: 'active',
      });
    } catch (err) {
      console.error('Error:', err);
    }
  };

  return (
    <div className="flex h-screen bg-slate-950">
      {/* Left Sidebar */}
      <div className="w-80 border-r border-slate-800 flex flex-col">
        {/* Header */}
        <div className="border-b border-slate-800 p-4">
          <h2 className="text-lg font-semibold text-white mb-4">
            Conversaciones ({filteredConversations.length})
          </h2>
          <input
            type="text"
            placeholder="Search by phone..."
            value={searchPhone}
            onChange={(e) => setSearchPhone(e.target.value)}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:border-yellow-400 text-sm"
          />
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-slate-400">Loading conversations...</div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-4 text-center text-slate-400">No conversations found</div>
          ) : (
            filteredConversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => setSelectedConversation(conv)}
                className={`w-full px-4 py-3 text-left border-b border-slate-800 transition-colors ${
                  selectedConversation?.id === conv.id
                    ? 'bg-slate-800'
                    : 'hover:bg-slate-800/50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-white truncate">
                        {conv.customer_name || conv.phone_number}
                      </h3>
                      {conv.status === 'escalated' && (
                        <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                      )}
                    </div>
                    <p className="text-xs text-slate-400 truncate mt-1">
                      {conv.last_message}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {formatTime(conv.last_message_timestamp || '')}
                    </p>
                  </div>
                  <div className={`text-xs px-2 py-1 rounded flex-shrink-0 ${getStatusColor(conv.status)}`}>
                    {conv.status}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 p-4">
          <button
            onClick={() => {
              supabase.auth.signOut();
              router.push('/login');
            }}
            className="w-full px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-sm transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedConversation ? (
          <>
            {/* Header */}
            <div className="border-b border-slate-800 p-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">
                  {selectedConversation.customer_name || selectedConversation.phone_number}
                </h2>
                <p className="text-sm text-slate-400 mt-1">
                  {selectedConversation.phone_number}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs px-3 py-1 rounded ${getStatusColor(selectedConversation.status)}`}>
                  {selectedConversation.status}
                </span>
                {selectedConversation.status === 'escalated' && (
                  <button
                    onClick={handleReturnToAI}
                    className="px-3 py-1 bg-blue-700 hover:bg-blue-600 text-white text-sm rounded transition-colors"
                  >
                    Return to AI
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4">
              {messageLoading ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-slate-400">Loading messages...</p>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-slate-400">No messages yet</p>
                </div>
              ) : (
                <>
                  {messages.map((msg) => (
                    <ChatBubble
                      key={msg.id}
                      role={msg.role}
                      content={msg.content}
                      timestamp={formatTime(msg.created_at)}
                      handoffDetected={msg.handoff_detected}
                    />
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-5xl mb-4">☀️</div>
              <h3 className="text-xl font-semibold text-white mb-2">Oiikon Sol</h3>
              <p className="text-slate-400">
                Select a conversation to get started
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
