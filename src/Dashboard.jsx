import { useEffect, useMemo, useState } from "react";
import NodeComponent from "./components/Node";

const imgAvatarPlaceholder = "https://www.figma.com/api/mcp/asset/9aeb17c4-c563-4a15-8e50-b91de7dfef67";
const imgIcon = "https://www.figma.com/api/mcp/asset/17b4cb08-b402-4b5f-a617-03f324c4c737";
const imgHardwareNode = "https://www.figma.com/api/mcp/asset/d72b65f0-5577-4522-b31d-55877af4ad1b";
const imgContainer = "https://www.figma.com/api/mcp/asset/7773fb49-07dc-4887-a776-a591e9bfce72";
const imgContainer1 = "https://www.figma.com/api/mcp/asset/62872bb1-7538-414c-8228-0b610dbaf7ab";
const imgContainer2 = "https://www.figma.com/api/mcp/asset/912053a5-59bc-4ac5-a188-4c8bd181c35f";

const defaultNodes = [
  { id: "0x7a...92b1", status: "active", x: 280, y: 170 },
  { id: "0x8b...a12c", status: "slashed", x: 470, y: 290 },
  { id: "0x71...3a", status: "syncing", x: 190, y: 250 },
];

function normalizeNode(node, index = 0) {
  return {
    id: node.id ?? `node-${index}`,
    status: node.status ?? "down",
    x: Number.isFinite(node.x) ? node.x : 120 + (index % 6) * 90,
    y: Number.isFinite(node.y) ? node.y : 120 + Math.floor(index / 6) * 90,
  };
}

function upsertNode(existingNodes, incomingNode) {
  const node = normalizeNode(incomingNode);
  const index = existingNodes.findIndex((item) => item.id === node.id);

  if (index === -1) {
    return [...existingNodes, node];
  }

  const next = [...existingNodes];
  next[index] = { ...next[index], ...node };
  return next;
}

function parseEventPayload(rawData) {
  if (!rawData) {
    return null;
  }

  try {
    return JSON.parse(rawData);
  } catch {
    return null;
  }
}

function GenericAvatar({ className }) {
  return (
    <div className={className || ""} data-name="Generic avatar" data-node-id="1:11">
      <div className="bg-[var(--schemes\/primary-container,#eaddff)] overflow-clip relative rounded-[100px] size-[40px]" data-name="Style=Avatar" data-node-id="1:12">
        <div className="absolute bottom-[10.92%] left-[14.77%] right-[14.77%] top-1/4" data-name="Avatar Placeholder" data-node-id="1:13">
          <img alt="" className="absolute block max-w-none size-full" src={imgAvatarPlaceholder} />
        </div>
      </div>
    </div>
  );
}

function DarkMode({ className }) {
  return (
    <div className={className || "relative size-[24px]"} data-name="dark_mode" data-node-id="9:5">
      <div className="absolute inset-[12.5%]" data-name="icon" data-node-id="9:6">
        <img alt="" className="absolute block max-w-none size-full" src={imgIcon} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [nodes, setNodes] = useState(defaultNodes);

  useEffect(() => {
    const controller = new AbortController();

    const loadInitialNodes = async () => {
      try {
        const response = await fetch("/api/nodes", { signal: controller.signal });
        if (!response.ok) {
          return;
        }

        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          setNodes(data.map((node, index) => normalizeNode(node, index)));
        }
      } catch {
      }
    };

    const applyIncomingNode = (payload, eventType) => {
      if (!payload) {
        return;
      }

      if (Array.isArray(payload)) {
        setNodes(payload.map((node, index) => normalizeNode(node, index)));
        return;
      }

      if (eventType === "NODE_REMOVED" || payload.type === "NODE_REMOVED") {
        const idToRemove = payload.id ?? payload.node?.id;
        if (!idToRemove) {
          return;
        }

        setNodes((current) => current.filter((node) => node.id !== idToRemove));
        return;
      }

      const nodePayload = payload.node ?? payload;
      if (!nodePayload?.id) {
        return;
      }

      setNodes((current) => upsertNode(current, nodePayload));
    };

    loadInitialNodes();

    const stream = new EventSource("/api/nodes/stream");

    const handleMessage = (event) => {
      const payload = parseEventPayload(event.data);
      applyIncomingNode(payload, event.type);
    };

    stream.onmessage = handleMessage;
    stream.addEventListener("NODE_STARTED", handleMessage);
    stream.addEventListener("NODE_UPDATED", handleMessage);
    stream.addEventListener("NODE_REMOVED", handleMessage);

    return () => {
      controller.abort();
      stream.close();
    };
  }, []);

  const nodeCounts = useMemo(
    () =>
      nodes.reduce(
        (accumulator, node) => {
          if (node.status === "active") {
            accumulator.active += 1;
          } else if (node.status === "syncing") {
            accumulator.syncing += 1;
          } else {
            accumulator.down += 1;
          }

          return accumulator;
        },
        { active: 0, syncing: 0, down: 0 },
      ),
    [nodes],
  );

  return (
    <div className="bg-[#f4f4f0] content-stretch flex flex-col isolate items-start relative size-full" data-name="Body" data-node-id="1:20">
      <div className="bg-[#f4f4f0] border-b border-black border-solid h-[64px] relative shrink-0 w-full z-[2]" data-name="Header" data-node-id="1:21">
        <div className="-translate-y-1/2 absolute content-stretch flex gap-[16px] items-center left-[24px] top-1/2" data-name="Container" data-node-id="1:22">
          <div className="bg-black shrink-0 size-[24px]" data-name="Background" data-node-id="1:23" />
          <div className="content-stretch flex flex-col items-start relative shrink-0" data-name="Heading 1" data-node-id="1:24">
            <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold h-[28px] justify-center leading-[0] relative shrink-0 text-[20px] text-black tracking-[-1px] uppercase w-[151.61px]" data-node-id="1:25">
              <p className="leading-[28px]">TBD</p>
            </div>
          </div>
        </div>
        <DarkMode className="absolute left-[1160px] overflow-clip size-[24px] top-[15px]" />
        <GenericAvatar className="absolute bg-[var(--schemes\/primary-container,#eaddff)] left-[1216.01px] overflow-clip rounded-[100px] size-[40px] top-[11.5px]" />
      </div>
      <div className="content-stretch flex flex-[1_0_0] items-start min-h-px min-w-px overflow-clip relative w-full z-[1]" data-name="Container" data-node-id="1:27">
        <div className="bg-[#f4f4f0] border-black border-r border-solid content-stretch flex flex-col h-full items-start justify-between pr-px relative shrink-0 w-[256px]" data-name="Nav" data-node-id="1:28">
          <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:29">
            <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
              <div className="border-b border-black border-solid content-stretch flex flex-col gap-[8px] items-start pb-[17px] pt-[16px] px-[16px] relative shrink-0 w-full" data-name="HorizontalBorder" data-node-id="1:30">
                <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:31">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                    <div className="flex flex-col font-['Inter:Regular',sans-serif] font-normal justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-full" data-node-id="1:32">
                      <p className="leading-[15px]">Platform</p>
                    </div>
                  </div>
                </div>
                <div className="relative shrink-0 w-full" data-name="List" data-node-id="1:33">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col gap-[4px] items-start relative w-full">
                    <div className="border-0 border-black border-solid content-stretch flex flex-col items-start px-[12px] py-[8px] relative shrink-0 w-full" data-name="Item → Link" data-node-id="1:34">
                      <div className="flex flex-col font-['Space_Grotesk:Medium',sans-serif] font-medium h-[28px] justify-center leading-[0] relative shrink-0 text-[18px] text-black w-[93.98px]" data-node-id="1:35">
                        <p className="leading-[28px]">Dashboard</p>
                      </div>
                    </div>
                    <div className="bg-black border-[rgba(0,0,0,0)] border-l-4 border-solid content-stretch flex flex-col items-start pl-[16px] pr-[12px] py-[8px] relative shrink-0 w-full" data-name="Item → Link" data-node-id="1:36">
                      <div className="flex flex-col font-['Space_Grotesk:Medium',sans-serif] font-medium h-[28px] justify-center leading-[0] relative shrink-0 text-[18px] text-white w-[134px]" data-node-id="24:57">
                        <p className="leading-[28px]">Nodes</p>
                      </div>
                    </div>
                    <div className="border-[rgba(0,0,0,0)] border-l-4 border-solid content-stretch flex flex-col items-start pl-[16px] pr-[12px] py-[8px] relative shrink-0 w-full" data-name="Item → Link" data-node-id="1:38">
                      <div className="flex flex-col font-['Space_Grotesk:Medium',sans-serif] font-medium h-[28px] justify-center leading-[0] relative shrink-0 text-[18px] text-black w-[150px]" data-node-id="1:39">
                        <p className="leading-[28px]">Topology</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="border-b border-black border-solid content-stretch flex flex-col gap-[8px] items-start pb-[17px] pt-[16px] px-[16px] relative shrink-0 w-full" data-name="HorizontalBorder" data-node-id="1:40">
                <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:41">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                    <div className="flex flex-col font-['Inter:Regular',sans-serif] font-normal justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-full" data-node-id="1:42">
                      <p className="leading-[15px]">Systems</p>
                    </div>
                  </div>
                </div>
                <div className="relative shrink-0 w-full" data-name="List" data-node-id="1:43">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col gap-[4px] items-start relative w-full">
                    <div className="border-[rgba(0,0,0,0)] border-l-4 border-solid content-stretch flex items-center justify-between pl-[16px] pr-[12px] py-[8px] relative shrink-0 w-full" data-name="Item → Link" data-node-id="1:44">
                      <div className="flex flex-col font-['Space_Grotesk:Regular',sans-serif] font-normal h-[28px] justify-center leading-[0] relative shrink-0 text-[#9ca3af] text-[18px] w-[78px]" data-node-id="1:45">
                        <p className="leading-[28px]">Gemini AI</p>
                      </div>
                      <div className="relative shrink-0" data-name="Container" data-node-id="1:46">
                        <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative">
                          <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[28px] justify-center leading-[0] not-italic relative shrink-0 text-[#0047ff] text-[10px] w-[24.48px]" data-node-id="1:47">
                            <p className="leading-[28px]">BETA</p>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="border-[rgba(0,0,0,0)] border-l-4 border-solid content-stretch flex flex-col items-start pl-[16px] pr-[12px] py-[8px] relative shrink-0 w-full" data-name="Item → Link" data-node-id="1:48">
                      <div className="flex flex-col font-['Space_Grotesk:Regular',sans-serif] font-normal h-[28px] justify-center leading-[0] relative shrink-0 text-[#9ca3af] text-[18px] w-[141.17px]" data-node-id="1:49">
                        <p className="leading-[28px]">Module Foundry</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="h-[48px] shrink-0 w-full" data-name="Container" data-node-id="1:50" />
        </div>
        <div className="bg-white content-stretch flex flex-[1_0_0] flex-col h-full isolate items-start min-h-px min-w-px relative" data-name="Main" data-node-id="1:52">
          <div className="absolute bg-[#f4f4f0] border border-black border-solid content-stretch flex flex-col gap-[4px] items-start leading-[0] left-[16px] p-[9px] top-[16px] z-[3]" data-name="Paragraph+Background+Border" data-node-id="1:53">
            <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold h-[24px] justify-center relative shrink-0 text-[24px] text-black uppercase w-[235.78px]" data-node-id="1:54">
              <p className="leading-[24px]">Network Topology</p>
            </div>
            <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center not-italic relative shrink-0 text-[#6b7280] text-[12px] w-[146.89px]" data-node-id="1:55">
              <p className="leading-[16px]">MAINNET ORGANIC MESH</p>
            </div>
          </div>
          <div className="network-map-container flex-[1_0_0] min-h-px min-w-px overflow-clip relative w-full z-[2]" data-name="Background" data-node-id="1:56">
            {nodes.map((node) => (
              <NodeComponent
                key={node.id}
                id={node.id}
                status={node.status}
                style={{ left: `${node.x}px`, top: `${node.y}px` }}
              />
            ))}
            <div className="absolute bg-[#f4f4f0] border-black border-solid border-t bottom-0 content-stretch flex h-[48px] items-center justify-between left-0 pt-px px-[16px] right-0" data-name="Background+HorizontalBorder" data-node-id="1:64">
              <div className="relative shrink-0" data-name="Container" data-node-id="1:65">
                <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex gap-[24px] items-center relative">
                  <div className="content-stretch flex gap-[8px] items-center relative shrink-0" data-name="Container" data-node-id="1:66">
                    <div className="bg-[#00c853] border border-black border-solid rounded-[9999px] shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:67" />
                    <div className="content-stretch flex flex-col items-start relative shrink-0" data-name="Container" data-node-id="1:68">
                      <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[80.8px]" data-node-id="1:69">
                        <p className="leading-[16px]">ACTIVE ({nodeCounts.active})</p>
                      </div>
                    </div>
                  </div>
                  <div className="content-stretch flex gap-[8px] items-center relative shrink-0" data-name="Container" data-node-id="1:70">
                    <div className="bg-[#fc0] border border-black border-solid rounded-[9999px] shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:71" />
                    <div className="content-stretch flex flex-col items-start relative shrink-0" data-name="Container" data-node-id="1:72">
                      <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[80.8px]" data-node-id="1:73">
                        <p className="leading-[16px]">SYNCING ({nodeCounts.syncing})</p>
                      </div>
                    </div>
                  </div>
                  <div className="content-stretch flex gap-[8px] items-center relative shrink-0" data-name="Container" data-node-id="1:74">
                    <div className="bg-[#ff3b30] border border-black border-solid rounded-[9999px] shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:75" />
                    <div className="content-stretch flex flex-col items-start relative shrink-0" data-name="Container" data-node-id="1:76">
                      <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[58.77px]" data-node-id="1:77">
                        <p className="leading-[16px]">DOWN ({nodeCounts.down})</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="relative shrink-0" data-name="Container" data-node-id="1:78">
                <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative">
                  <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#0047ff] text-[12px] w-[154.23px]" data-node-id="1:79">
                    <p className="leading-[16px]">GLOBAL HASH: 450 TH/s</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-[#f4f4f0] border-black border-solid border-t content-stretch flex flex-col h-[256px] items-start pt-px relative shrink-0 w-full z-[1]" data-name="Background+HorizontalBorder" data-node-id="1:122">
            <div className="bg-white border-b border-black border-solid h-[40px] relative shrink-0 w-full" data-name="Background+HorizontalBorder" data-node-id="1:123">
              <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex items-center justify-between pb-px px-[16px] relative size-full">
                <div className="relative shrink-0" data-name="Heading 3" data-node-id="1:124">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative">
                    <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold h-[20px] justify-center leading-[0] relative shrink-0 text-[14px] text-black uppercase w-[108.48px]" data-node-id="1:125">
                      <p className="leading-[20px]">Live Event Feed</p>
                    </div>
                  </div>
                </div>
                <div className="relative shrink-0" data-name="Container" data-node-id="1:126">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex gap-[8px] items-start relative">
                    <div className="border border-black border-solid content-stretch flex items-center justify-center p-px relative shrink-0 size-[24px]" data-name="Button" data-node-id="1:127">
                      <div className="h-[7px] relative shrink-0 w-[10.5px]" data-name="Container" data-node-id="1:128">
                        <img alt="" className="absolute block max-w-none size-full" src={imgContainer} />
                      </div>
                    </div>
                    <div className="border border-black border-solid content-stretch flex items-center justify-center p-px relative shrink-0 size-[24px]" data-name="Button" data-node-id="1:130">
                      <div className="relative shrink-0 size-[9.333px]" data-name="Container" data-node-id="1:131">
                        <img alt="" className="absolute block max-w-none size-full" src={imgContainer1} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="bg-white flex-[1_0_0] min-h-px min-w-px relative w-full" data-name="Background" data-node-id="1:133">
              <div className="bg-clip-padding border-0 border-[transparent] border-solid overflow-clip relative rounded-[inherit] size-full">
                <div className="absolute content-stretch flex flex-col isolate items-start left-0 right-0 top-0" data-name="Table" data-node-id="1:134">
                  <div className="bg-[#f4f4f0] content-stretch flex flex-col items-start relative shrink-0 w-full z-[2]" data-name="Header" data-node-id="1:135">
                    <div className="content-stretch flex items-start justify-center relative shrink-0 w-full" data-name="Row" data-node-id="1:136">
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[9px] pl-[16px] pr-[17px] pt-[8px] relative shrink-0 w-[128px]" data-name="Cell" data-node-id="1:137">
                        <div className="flex flex-col font-['Inter:Bold',sans-serif] font-bold h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-[55.86px]" data-node-id="1:138">
                          <p className="leading-[16px]">Time (UTC)</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[9px] pl-[16px] pr-[17px] pt-[8px] relative shrink-0 w-[80px]" data-name="Cell" data-node-id="1:139">
                        <div className="flex flex-col font-['Inter:Bold',sans-serif] font-bold h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-[39.39px]" data-node-id="1:140">
                          <p className="leading-[16px]">Status</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[9px] pl-[16px] pr-[17px] pt-[8px] relative shrink-0 w-[160px]" data-name="Cell" data-node-id="1:141">
                        <div className="flex flex-col font-['Inter:Bold',sans-serif] font-bold h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-[41.03px]" data-node-id="1:142">
                          <p className="leading-[16px]">Node ID</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-solid content-stretch flex flex-col items-start pb-[9px] pt-[8px] px-[16px] relative shrink-0 w-[336px]" data-name="Cell" data-node-id="1:143">
                        <div className="flex flex-col font-['Inter:Bold',sans-serif] font-bold h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-[56.88px]" data-node-id="1:144">
                          <p className="leading-[16px]">Event Log</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="content-stretch flex flex-col items-start relative shrink-0 w-full z-[1]" data-name="Body" data-node-id="1:145">
                    <div className="content-stretch flex items-start justify-center relative shrink-0 w-full" data-name="Row" data-node-id="1:146">
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[13px] pl-[16px] pr-[17px] pt-[12px] relative shrink-0 w-[128px]" data-name="Data" data-node-id="1:147">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#4b5563] text-[12px] w-[58.77px]" data-node-id="1:148">
                          <p className="leading-[16px]">14:02:44</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-center px-[34px] py-[14.5px] relative shrink-0 w-[80px]" data-name="Data" data-node-id="1:149">
                        <div className="bg-[#00c853] border border-black border-solid shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:150" />
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[13px] pl-[16px] pr-[17px] pt-[12px] relative shrink-0 w-[160px]" data-name="Data" data-node-id="1:151">
                        <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[66.11px]" data-node-id="1:152">
                          <p className="leading-[16px]">0x71...3A</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-solid content-stretch flex flex-col items-start pb-[13px] pt-[12px] px-[16px] relative shrink-0 w-[336px]" data-name="Data" data-node-id="1:153">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[242.36px]" data-node-id="1:154">
                          <p className="leading-[16px]">Handshake verified. Latency 12ms.</p>
                        </div>
                      </div>
                    </div>
                    <div className="content-stretch flex items-start justify-center relative shrink-0 w-full" data-name="Row" data-node-id="1:155">
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[21px] pl-[16px] pr-[17px] pt-[20px] relative shrink-0 w-[128px]" data-name="Data" data-node-id="1:156">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#4b5563] text-[12px] w-[58.77px]" data-node-id="1:157">
                          <p className="leading-[16px]">14:02:12</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-center px-[34px] py-[22.5px] relative shrink-0 w-[80px]" data-name="Data" data-node-id="1:158">
                        <div className="bg-black border border-black border-solid shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:159" />
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[21px] pl-[16px] pr-[17px] pt-[20px] relative shrink-0 w-[160px]" data-name="Data" data-node-id="1:160">
                        <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[66.11px]" data-node-id="1:161">
                          <p className="leading-[16px]">0x8B...9C</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-solid content-stretch flex flex-col items-start pb-[13px] pt-[12px] px-[16px] relative shrink-0 w-[336px]" data-name="Data" data-node-id="1:162">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[32px] justify-center leading-[16px] not-italic relative shrink-0 text-[12px] text-black w-[227.67px]" data-node-id="1:163">
                          <p className="mb-0">Block #994821 committed. Reward</p>
                          <p>distributed.</p>
                        </div>
                      </div>
                    </div>
                    <div className="bg-[rgba(254,242,242,0.3)] content-stretch flex items-start justify-center relative shrink-0 w-full" data-name="Row" data-node-id="1:164">
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[21px] pl-[16px] pr-[17px] pt-[20px] relative shrink-0 w-[128px]" data-name="Data" data-node-id="1:165">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#ff3b30] text-[12px] w-[58.77px]" data-node-id="1:166">
                          <p className="leading-[16px]">14:01:58</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-center px-[34px] py-[22.5px] relative shrink-0 w-[80px]" data-name="Data" data-node-id="1:167">
                        <div className="bg-[#ff3b30] border border-black border-solid shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:168" />
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[21px] pl-[16px] pr-[17px] pt-[20px] relative shrink-0 w-[160px]" data-name="Data" data-node-id="1:169">
                        <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#ff3b30] text-[12px] w-[66.11px]" data-node-id="1:170">
                          <p className="leading-[16px]">0x4A...21</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-solid content-stretch flex flex-col items-start pb-[13px] pt-[12px] px-[16px] relative shrink-0 w-[336px]" data-name="Data" data-node-id="1:171">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[32px] justify-center leading-[16px] not-italic relative shrink-0 text-[#ff3b30] text-[12px] w-[257.05px]" data-node-id="1:172">
                          <p className="mb-0">CONNECTION_LOST: Keep-alive timeout</p>
                          <p>exceeded.</p>
                        </div>
                      </div>
                    </div>
                    <div className="content-stretch flex items-start justify-center relative shrink-0 w-full" data-name="Row" data-node-id="1:173">
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[21px] pl-[16px] pr-[17px] pt-[20px] relative shrink-0 w-[128px]" data-name="Data" data-node-id="1:174">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#4b5563] text-[12px] w-[58.77px]" data-node-id="1:175">
                          <p className="leading-[16px]">14:01:45</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-center px-[34px] py-[22.5px] relative shrink-0 w-[80px]" data-name="Data" data-node-id="1:176">
                        <div className="bg-[#00c853] border border-black border-solid shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:177" />
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[21px] pl-[16px] pr-[17px] pt-[20px] relative shrink-0 w-[160px]" data-name="Data" data-node-id="1:178">
                        <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[66.11px]" data-node-id="1:179">
                          <p className="leading-[16px]">0x71...3A</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-solid content-stretch flex flex-col items-start pb-[13px] pt-[12px] px-[16px] relative shrink-0 w-[336px]" data-name="Data" data-node-id="1:180">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[32px] justify-center leading-[16px] not-italic relative shrink-0 text-[12px] text-black w-[235.02px]" data-node-id="1:181">
                          <p className="mb-0">Temperature regulated. Fan curve</p>
                          <p>normalized.</p>
                        </div>
                      </div>
                    </div>
                    <div className="content-stretch flex items-start justify-center relative shrink-0 w-full" data-name="Row" data-node-id="1:182">
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[13px] pl-[16px] pr-[17px] pt-[12px] relative shrink-0 w-[128px]" data-name="Data" data-node-id="1:183">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#4b5563] text-[12px] w-[58.77px]" data-node-id="1:184">
                          <p className="leading-[16px]">14:00:22</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-center px-[34px] py-[14.5px] relative shrink-0 w-[80px]" data-name="Data" data-node-id="1:185">
                        <div className="bg-white border border-black border-solid shrink-0 size-[12px]" data-name="Background+Border" data-node-id="1:186" />
                      </div>
                      <div className="border-b border-black border-r border-solid content-stretch flex flex-col items-start pb-[13px] pl-[16px] pr-[17px] pt-[12px] relative shrink-0 w-[160px]" data-name="Data" data-node-id="1:187">
                        <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[66.11px]" data-node-id="1:188">
                          <p className="leading-[16px]">0x12...FF</p>
                        </div>
                      </div>
                      <div className="border-b border-black border-solid content-stretch flex flex-col items-start pb-[13px] pt-[12px] px-[16px] relative shrink-0 w-[336px]" data-name="Data" data-node-id="1:189">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black w-[264.39px]" data-node-id="1:190">
                          <p className="leading-[16px]">Entering low-power maintenance mode.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-[#f4f4f0] border-black border-l border-solid content-stretch flex flex-col h-full items-start pl-px relative shrink-0 w-[320px]" data-name="Aside" data-node-id="1:191">
          <div className="border-b border-black border-solid flex-[1_0_0] min-h-px min-w-px relative w-full" data-name="HorizontalBorder" data-node-id="1:192">
            <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start pb-px relative size-full">
              <div className="bg-black border-b border-black border-solid h-[40px] relative shrink-0 w-full" data-name="Background+HorizontalBorder" data-node-id="1:193">
                <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex items-center pb-px px-[16px] relative size-full">
                  <div className="relative shrink-0" data-name="Heading 3" data-node-id="1:194">
                    <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative">
                      <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold h-[20px] justify-center leading-[0] relative shrink-0 text-[14px] text-white uppercase w-[111.92px]" data-node-id="1:195">
                        <p className="leading-[20px]">Node Inspector</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-white flex-[1_0_0] min-h-px min-w-px relative w-full" data-name="Background" data-node-id="1:196">
                <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col gap-[16px] items-start p-[16px] relative size-full">
                  <div className="bg-[#e5e7eb] border border-black border-solid content-stretch flex flex-col items-start justify-center overflow-clip p-px relative shrink-0 w-full" data-name="Background+Border" data-node-id="1:197">
                    <div className="h-[159.44px] relative shrink-0 w-full" data-name="Hardware Node" data-node-id="1:198">
                      <div aria-hidden="true" className="absolute bg-clip-padding border-0 border-[transparent] border-solid inset-0 pointer-events-none">
                        <div className="absolute bg-clip-padding border-0 border-[transparent] border-solid inset-0 overflow-hidden">
                          <img alt="" className="absolute h-[178.75%] left-0 max-w-none top-[-39.38%] w-full" src={imgHardwareNode} />
                        </div>
                        <div className="absolute bg-clip-padding bg-white border-0 border-[transparent] border-solid inset-0 mix-blend-saturation" />
                      </div>
                    </div>
                    <div className="absolute bg-black bottom-[8px] right-[8px]" data-name="Background" data-node-id="1:199">
                      <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start px-[4px] relative">
                        <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[15px] justify-center leading-[0] not-italic relative shrink-0 text-[10px] text-white w-[36.73px]" data-node-id="1:200">
                          <p className="leading-[15px]">CAM_01</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="border-b border-black border-solid content-stretch flex flex-col items-start pb-[9px] relative shrink-0 w-full" data-name="HorizontalBorder" data-node-id="1:201">
                    <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[20px] justify-center leading-[0] not-italic relative shrink-0 text-[14px] text-black w-[269px]" data-node-id="1:202">
                      <p className="leading-[20px]">NODE NAME: RASPBERRY-PI-1</p>
                    </div>
                  </div>
                  <div className="h-[138px] relative shrink-0 w-full" data-name="Container" data-node-id="1:203">
                    <div className="absolute border border-black border-solid content-stretch flex flex-col items-start left-0 p-[9px] right-[151.5px] top-0" data-name="Border" data-node-id="1:204">
                      <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:205">
                        <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                          <div className="flex flex-col font-['Inter:Regular',sans-serif] font-normal justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-full" data-node-id="1:206">
                            <p className="leading-[15px]">STATUS</p>
                          </div>
                        </div>
                      </div>
                      <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:207">
                        <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                          <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold justify-center leading-[0] relative shrink-0 text-[#00c853] text-[20px] w-full" data-node-id="1:208">
                            <p className="leading-[28px]">UP</p>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="absolute border border-black border-solid content-stretch flex flex-col h-[138px] items-start left-[152px] p-[9px] right-0 top-[-0.44px]" data-name="Border" data-node-id="1:209">
                      <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:210">
                        <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                          <div className="flex flex-col font-['Inter:Regular',sans-serif] font-normal justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-full" data-node-id="1:211">
                            <p className="leading-[15px]">DEVICES</p>
                          </div>
                        </div>
                      </div>
                      <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:212">
                        <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                          <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold justify-center leading-[28px] relative shrink-0 text-[#00c853] text-[20px] w-full" data-node-id="1:213">
                            <p className="mb-0">TOUCH_A</p>
                            <p>SOUND_A</p>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="absolute border border-black border-solid content-stretch flex flex-col items-start left-0 p-[9px] right-[151.5px] top-[77px]" data-name="Border" data-node-id="1:214">
                      <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:215">
                        <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                          <div className="flex flex-col font-['Inter:Regular',sans-serif] font-normal justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[10px] uppercase w-full" data-node-id="1:216">
                            <p className="leading-[15px]">WATCHING PEER</p>
                          </div>
                        </div>
                      </div>
                      <div className="relative shrink-0 w-full" data-name="Container" data-node-id="1:217">
                        <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative w-full">
                          <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold justify-center leading-[0] relative shrink-0 text-[#fc0] text-[20px] w-full" data-node-id="1:218">
                            <p className="leading-[28px]">RELAY_A</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="border border-black border-solid content-stretch flex items-center justify-center px-px py-[9px] relative shrink-0 w-full" data-name="Button" data-node-id="1:224">
                    <div className="flex flex-col font-['Inter:Bold',sans-serif] font-bold h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-black text-center uppercase w-[139.31px]" data-node-id="1:225">
                      <p className="leading-[16px]">View Full Telemetry</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-[#f4f4f0] flex-[1_0_0] min-h-px min-w-px relative w-full" data-name="Background" data-node-id="1:226">
            <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start relative size-full">
              <div className="bg-white border-b border-black border-solid content-stretch flex h-[40px] items-center pb-px px-[16px] relative shrink-0 w-full" data-name="Background+HorizontalBorder" data-node-id="1:227">
                <div className="relative shrink-0" data-name="Heading 3" data-node-id="1:228">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex gap-[8px] items-center relative">
                    <div className="relative shrink-0 size-[12.833px]" data-name="Container" data-node-id="1:229">
                      <img alt="" className="absolute block max-w-none size-full" src={imgContainer2} />
                    </div>
                    <div className="flex flex-col font-['Space_Grotesk:Bold',sans-serif] font-bold h-[20px] justify-center leading-[0] relative shrink-0 text-[14px] text-black uppercase w-[140.81px]" data-node-id="1:231">
                      <p className="leading-[20px]">Gemini Intelligence</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="content-stretch flex flex-[1_0_0] flex-col gap-[16px] items-start min-h-px min-w-px overflow-clip p-[16px] relative w-full" data-name="Container" data-node-id="1:232">
                <div className="content-stretch flex gap-[8px] items-start relative shrink-0 w-full" data-name="Container" data-node-id="1:233">
                  <div className="bg-[#0047ff] content-stretch flex items-center justify-center pb-[4.5px] pt-[3.5px] relative shrink-0 size-[24px]" data-name="Background" data-node-id="1:234">
                    <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-center text-white w-[7.36px]" data-node-id="1:235">
                      <p className="leading-[16px]">G</p>
                    </div>
                  </div>
                  <div className="bg-white border border-black border-solid content-stretch flex flex-col font-['Space_Mono:Regular',sans-serif] gap-[16px] items-start not-italic pl-[13px] pr-[14.33px] py-[13px] relative self-stretch shadow-[2px_2px_0px_0px_black] shrink-0 text-[12px]" data-name="Paragraph+Background+Border+Shadow" data-node-id="1:236">
                    <div className="flex flex-col h-[64px] justify-center leading-[16px] relative shrink-0 text-black w-[227.67px]" data-node-id="1:237">
                      <p className="mb-0">System scan complete. Anomaly</p>
                      <p className="mb-0">detected in Node 0x4A...21.</p>
                      <p className="mb-0">Driver version mismatch causing</p>
                      <p>periodic timeout.</p>
                    </div>
                    <div className="flex flex-col h-[16px] justify-center leading-[0] relative shrink-0 text-[#0047ff] w-[183.61px]" data-node-id="1:238">
                      <p className="[text-decoration-skip-ink:none] decoration-solid leading-[16px] underline">{`>> View Diagnostic Report`}</p>
                    </div>
                  </div>
                </div>
                <div className="content-stretch flex gap-[8px] items-start relative shrink-0 w-full" data-name="Container" data-node-id="1:239">
                  <div className="bg-[#e5e7eb] border border-black border-solid content-stretch flex flex-col items-start pl-[13px] pr-[21.67px] py-[13px] relative self-stretch shrink-0" data-name="Background+Border" data-node-id="1:240">
                    <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[32px] justify-center leading-[16px] not-italic relative shrink-0 text-[12px] text-black w-[220.33px]" data-node-id="1:241">
                      <p className="mb-0">Apply patch v2.4.2 to affected</p>
                      <p>nodes.</p>
                    </div>
                  </div>
                  <div className="bg-black content-stretch flex items-center justify-center pb-[4.5px] pt-[3.5px] relative shrink-0 size-[24px]" data-name="Background" data-node-id="1:242">
                    <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-center text-white w-[7.36px]" data-node-id="1:243">
                      <p className="leading-[16px]">U</p>
                    </div>
                  </div>
                </div>
                <div className="content-stretch flex gap-[8px] h-[69px] items-start relative shrink-0 w-full" data-name="Container" data-node-id="1:244">
                  <div className="bg-[#0047ff] content-stretch flex items-center justify-center pb-[4.5px] pt-[3.5px] relative shrink-0 size-[24px]" data-name="Background" data-node-id="1:245">
                    <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[12px] text-center text-white w-[7.36px]" data-node-id="1:246">
                      <p className="leading-[16px]">G</p>
                    </div>
                  </div>
                  <div className="bg-white border border-black border-solid h-full relative shadow-[2px_2px_0px_0px_black] shrink-0 w-[231.64px]" data-name="Background+Border+Shadow" data-node-id="1:247">
                    <div className="-translate-y-1/2 absolute flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] left-[12px] not-italic text-[12px] text-black top-[19.5px] w-[205.64px]" data-node-id="1:248">
                      <p className="leading-[16px]">Patching sequence initiated.</p>
                    </div>
                    <div className="absolute bg-[#e5e7eb] h-[4px] left-[12px] top-[36px] w-[205.64px]" data-name="Background" data-node-id="1:249">
                      <div className="absolute bg-[#0047ff] h-[4px] left-0 right-[33.34%] top-0" data-name="Background" data-node-id="1:250" />
                    </div>
                    <div className="-translate-y-1/2 absolute flex flex-col font-['Space_Mono:Regular',sans-serif] h-[16px] justify-center leading-[0] left-[12px] not-italic text-[12px] text-black top-[51.5px] w-[190.95px]" data-node-id="1:251">
                      <p className="leading-[16px]">Estimated completion: 14s.</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bg-white border-black border-solid border-t content-stretch flex h-[48px] items-center pt-px px-[8px] relative shrink-0 w-full" data-name="Background+HorizontalBorder" data-node-id="1:252">
                <div className="relative shrink-0" data-name="Margin" data-node-id="1:253">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start pr-[8px] relative">
                    <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] h-[24px] justify-center leading-[0] not-italic relative shrink-0 text-[#9ca3af] text-[16px] w-[9.8px]" data-node-id="1:254">
                      <p className="leading-[24px]">{`>`}</p>
                    </div>
                  </div>
                </div>
                <div className="flex-[1_0_0] h-full min-h-px min-w-px relative" data-name="Input" data-node-id="1:255">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col items-start overflow-clip py-[15px] relative rounded-[inherit] size-full">
                    <div className="content-stretch flex flex-col items-start overflow-clip relative shrink-0 w-full" data-name="Container" data-node-id="1:256">
                      <div className="flex flex-col font-['Space_Mono:Regular',sans-serif] justify-center leading-[0] not-italic relative shrink-0 text-[#6b7280] text-[12px] w-full" data-node-id="1:257">
                        <p className="leading-[normal]">Type command or prompt...</p>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="h-[32px] relative shrink-0" data-name="Button" data-node-id="1:258">
                  <div className="bg-clip-padding border-0 border-[transparent] border-solid content-stretch flex flex-col h-full items-center justify-center pb-[8.5px] pt-[7.5px] px-[8px] relative">
                    <div className="flex flex-col font-['Space_Mono:Bold',sans-serif] h-[16px] justify-center leading-[0] not-italic relative shrink-0 text-[#0047ff] text-[12px] text-center uppercase w-[29.39px]" data-node-id="1:259">
                      <p className="leading-[16px]">Send</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
