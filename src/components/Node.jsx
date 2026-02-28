const statusClassMap = {
  active: "bg-[#00c853]",
  syncing: "bg-[#ffcc00]",
  down: "bg-[#ff3b30]",
  slashed: "bg-[#ff3b30]",
};

export default function Node({ id, status, style }) {
  const badgeClass = statusClassMap[status] ?? "bg-black";

  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2" style={style}>
      <div className={`border border-black rounded-[9999px] size-[32px] ${badgeClass}`} />
      <div className="absolute bg-black bottom-[-20px] left-1/2 -translate-x-1/2 px-[6px] py-[2px]">
        <p className="font-['Space_Mono:Regular',sans-serif] leading-[14px] text-[10px] text-white whitespace-nowrap">
          {id}
        </p>
      </div>
    </div>
  );
}
