export default function GeminiChat({ height, isDarkMode }) {
  return (
    <div
      style={{
        height,
        background: isDarkMode ? "#18181b" : "#fff",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: isDarkMode ? "#3f3f46" : "#ccc",
        fontFamily: "monospace",
        fontSize: 12,
        letterSpacing: "0.08em",
        transition: "background 0.3s, color 0.3s",
      }}
    >
      [ GeminiChat ]
    </div>
  );
}
