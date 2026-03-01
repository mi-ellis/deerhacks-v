import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader } from 'lucide-react';
import { GoogleGenerativeAI } from '@google/generative-ai';

const Chatbox = ({ isDarkMode, nodeData }) => {
  const [messages, setMessages] = useState([
    { type: 'bot', text: 'Hi! Ask me about the status of your nodes and I\'ll generate a report.' }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState(process.env.REACT_APP_GEMINI_API_KEY || '');
  const [showKeyInput, setShowKeyInput] = useState(!apiKey);
  const messagesEndRef = useRef(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const initializeAI = (key) => {
    if (!key) {
      alert('Please enter a valid API key');
      return null;
    }
    try {
      const genAI = new GoogleGenerativeAI(key);
      return genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    } catch (error) {
      alert('Invalid API key');
      return null;
    }
  };

  const handleApiKeySubmit = (e) => {
    e.preventDefault();
    setApiKey(apiKey);
    setShowKeyInput(false);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    // Add user message to chat
    const userMessage = {
      type: 'user',
      text: input
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const model = initializeAI(apiKey);
      if (!model) {
        setShowKeyInput(true);
        setLoading(false);
        return;
      }

      // Prepare context about the nodes
      const nodeContext = nodeData 
        ? `Current node data: ${JSON.stringify(nodeData, null, 2)}\n\n`
        : '';

      const prompt = `${nodeContext}User question: ${input}\n\nProvide a concise status report or answer based on the node data if available.`;

      const result = await model.generateContent(prompt);
      const botResponse = result.response.text();

      // Add bot response
      const botMessage = {
        type: 'bot',
        text: botResponse
      };
      setMessages(prev => [...prev, botMessage]);
    } catch (error) {
      const errorMessage = {
        type: 'bot',
        text: `Error: ${error.message || 'Failed to generate response'}`
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const bgColor = isDarkMode ? 'bg-zinc-800' : 'bg-white';
  const borderColor = isDarkMode ? 'border-zinc-700' : 'border-zinc-200';
  const inputBg = isDarkMode ? 'bg-zinc-700' : 'bg-zinc-100';
  const textColor = isDarkMode ? 'text-zinc-100' : 'text-zinc-900';

  if (showKeyInput) {
    return (
      <div className={`w-full h-96 ${bgColor} border ${borderColor} rounded-sm flex flex-col`}>
        <div className={`p-4 border-b ${borderColor} font-bold text-sm uppercase`}>
          API Configuration
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <form onSubmit={handleApiKeySubmit} className="w-full max-w-sm">
            <label className="block text-sm mb-2">Enter Gemini API Key:</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste your API key from aistudio.google.com"
              className={`w-full p-2 border ${borderColor} rounded text-sm ${inputBg} ${textColor} mb-3`}
            />
            <button
              type="submit"
              className="w-full bg-emerald-500 text-white p-2 rounded text-sm font-bold hover:bg-emerald-600 transition-colors"
            >
              Configure
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full h-96 ${bgColor} border ${borderColor} rounded-sm flex flex-col`}>
      {/* Header */}
      <div className={`p-4 border-b ${borderColor} font-bold text-sm uppercase flex justify-between items-center`}>
        <span>Node Status Assistant (Powered by Gemini 2.5 Flash)</span>
        <button
          onClick={() => setShowKeyInput(true)}
          className="text-xs text-emerald-500 hover:text-emerald-400"
        >
          Change Key
        </button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-xs p-3 rounded text-sm ${
                msg.type === 'user'
                  ? 'bg-emerald-500 text-white'
                  : isDarkMode
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'bg-zinc-100 text-zinc-900'
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className={`p-3 rounded ${isDarkMode ? 'bg-zinc-700' : 'bg-zinc-100'}`}>
              <Loader size={16} className="animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSendMessage} className={`p-4 border-t ${borderColor} flex gap-2`}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about node status..."
          disabled={loading}
          className={`flex-1 p-2 border ${borderColor} rounded text-sm ${inputBg} ${textColor} disabled:opacity-50`}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="p-2 bg-emerald-500 text-white rounded hover:bg-emerald-600 disabled:opacity-50 transition-colors"
        >
          <Send size={18} />
        </button>
      </form>
    </div>
  );
};

export default Chatbox;
