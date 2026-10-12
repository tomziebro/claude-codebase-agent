export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parses a Server-Sent Events byte stream into discrete events.
 * Handles events split across chunk boundaries, CRLF line endings,
 * multi-line `data:` fields and comment lines.
 */
export async function* parseSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n?/g, "\n");

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseEventBlock(raw);
      if (event) yield event;
    }
  }

  buffer += decoder.decode();
  const trailing = parseEventBlock(buffer.replace(/\r\n?/g, "\n").trim());
  if (trailing) yield trailing;
}

function parseEventBlock(raw: string): SseEvent | null {
  if (!raw) return null;
  let event = "message";
  const data: string[] = [];

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}
