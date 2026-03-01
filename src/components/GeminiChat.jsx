import React, { useState, useRef, useEffect } from "react";
import { Send, Loader } from "lucide-react";
import { GoogleGenerativeAI } from "@google/generative-ai";

export default function GeminiChat({ height, isDarkMode, nodeData }) {
  const [messages, setMessages] = useState([
    {
      type: "bot",
      text: "Hi! Ask me about the status of your nodes and I'll generate a report.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState(
    process.env.REACT_APP_GEMINI_API_KEY || "",
  );
  const [showKeyInput, setShowKeyInput] = useState(
    !process.env.REACT_APP_GEMINI_API_KEY,
  );
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const initializeAI = (key) => {
    if (!key) {
      alert("Please enter a valid API key");
      return null;
    }
    try {
      const genAI = new GoogleGenerativeAI(key);
      return genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    } catch {
      alert("Invalid API key");
      return null;
    }
  };

  const handleApiKeySubmit = (e) => {
    e.preventDefault();
    setShowKeyInput(false);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setMessages((prev) => [...prev, { type: "user", text: input }]);
    setInput("");
    setLoading(true);
    try {
      const model = initializeAI(apiKey);
      if (!model) {
        setShowKeyInput(true);
        setLoading(false);
        return;
      }
      const nodeContext = nodeData
        ? `Current node data: ${JSON.stringify(nodeData, null, 2)}\n\n`
        : "";
      const prompt = `${nodeContext}User question: ${input}\n\nProvide a concise status report or answer based on the node data if available.`;
      const result = await model.generateContent(prompt);
      setMessages((prev) => [
        ...prev,
        { type: "bot", text: result.response.text() },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          type: "bot",
          text: `Error: ${error.message || "Failed to generate response"}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const bgColor = isDarkMode ? "#18181b" : "#fff";
  const borderColor = isDarkMode ? "#3f3f46" : "#e4e4e7";
  const inputBg = isDarkMode ? "#27272a" : "#f4f4f5";
  const textColor = isDarkMode ? "#f4f4f5" : "#18181b";
  const mutedText = isDarkMode ? "#a1a1aa" : "#71717a";

  const containerStyle = {
    height,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: bgColor,
    borderTop: `1px solid ${borderColor}`,
    overflow: "hidden",
    transition: "background 0.3s",
  };

  if (showKeyInput) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            padding: "8px 12px",
            borderBottom: `1px solid ${borderColor}`,
            fontFamily: "monospace",
            fontSize: 9,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: mutedText,
            flexShrink: 0,
          }}
        >
          API Configuration
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <form onSubmit={handleApiKeySubmit} style={{ width: "100%" }}>
            <label
              style={{
                display: "block",
                fontSize: 11,
                marginBottom: 6,
                color: textColor,
                fontFamily: "monospace",
              }}
            >
              Gemini API Key:
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste key from aistudio.google.com"
              style={{
                width: "100%",
                padding: "6px 8px",
                border: `1px solid ${borderColor}`,
                borderRadius: 4,
                fontSize: 11,
                background: inputBg,
                color: textColor,
                marginBottom: 8,
                boxSizing: "border-box",
              }}
            />
            <button
              type="submit"
              style={{
                width: "100%",
                padding: "6px 0",
                background: "#10b981",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Configure
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: `1px solid ${borderColor}`,
          fontFamily: "monospace",
          fontSize: 9,
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          color: mutedText,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <span>Node Assistant · Gemini 2.5 Flash</span>
        <button
          onClick={() => setShowKeyInput(true)}
          style={{
            fontSize: 9,
            color: "#10b981",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "monospace",
            letterSpacing: "0.1em",
          }}
        >
          CHANGE KEY
        </button>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {messages.map((msg, idx) => (
          <div
            key={idx}
            style={{
              display: "flex",
              justifyContent: msg.type === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 11,
                lineHeight: 1.5,
                background: msg.type === "user" ? "#10b981" : inputBg,
                color: msg.type === "user" ? "#fff" : textColor,
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                background: inputBg,
              }}
            >
              <Loader
                size={13}
                style={{
                  animation: "spin 1s linear infinite",
                  color: mutedText,
                }}
              />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSendMessage}
        style={{
          display: "flex",
          gap: 6,
          padding: "8px 12px",
          borderTop: `1px solid ${borderColor}`,
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about node status…"
          disabled={loading}
          style={{
            flex: 1,
            padding: "5px 8px",
            border: `1px solid ${borderColor}`,
            borderRadius: 4,
            fontSize: 11,
            background: inputBg,
            color: textColor,
            fontFamily: "monospace",
            opacity: loading ? 0.5 : 1,
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: "5px 8px",
            background: "#10b981",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            opacity: loading || !input.trim() ? 0.5 : 1,
          }}
        >
          <Send size={13} />
        </button>
      </form>
    </div>
  );
}
