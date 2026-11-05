type JsonFrame =
  | {kind: 'object'; keys: Set<string>; state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'after'}
  | {kind: 'array'; state: 'valueOrEnd' | 'value' | 'after'};

/** Check the wire text before JSON.parse can discard duplicate object keys. */
export function parseJsonWithoutDuplicateKeys(text: string): unknown {
  const frames: JsonFrame[] = [];
  const primitive = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  let offset = 0, rootRead = false;
  const invalid = (): never => {throw new SyntaxError('Invalid JSON.');};
  const whitespace = () => {while (offset < text.length && /[ \t\r\n]/.test(text[offset])) offset++;};
  const string = (key = false): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') return key ? JSON.parse(text.slice(start, offset)) as string : '';
      if (character.charCodeAt(0) < 0x20) invalid();
      if (character !== '\\') continue;
      const escaped = text[offset++];
      if (escaped === 'u') {
        if (!/^[a-fA-F0-9]{4}$/.test(text.slice(offset, offset + 4))) invalid();
        offset += 4;
      } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) invalid();
    }
    return invalid();
  };
  const value = () => {
    const character = text[offset];
    if (character === '{') {offset++; frames.push({kind: 'object', keys: new Set(), state: 'keyOrEnd'});}
    else if (character === '[') {offset++; frames.push({kind: 'array', state: 'valueOrEnd'});}
    else if (character === '"') string();
    else {
      primitive.lastIndex = offset;
      if (!primitive.test(text)) invalid();
      offset = primitive.lastIndex;
    }
  };
  // An explicit stack also accepts deeply nested valid JSON without recursion.
  while (true) {
    whitespace();
    const frame = frames.at(-1), character = text[offset];
    if (!frame) {
      if (rootRead) break;
      rootRead = true; value(); continue;
    }
    if (frame.kind === 'object') {
      if (frame.state === 'keyOrEnd' || frame.state === 'key') {
        if (frame.state === 'keyOrEnd' && character === '}') {offset++; frames.pop(); continue;}
        if (character !== '"') invalid();
        const key = string(true);
        if (frame.keys.has(key)) throw new SyntaxError('Invalid JSON: duplicate object key.');
        frame.keys.add(key); frame.state = 'colon';
      } else if (frame.state === 'colon') {
        if (character !== ':') invalid();
        offset++; frame.state = 'value';
      } else if (frame.state === 'value') {frame.state = 'after'; value();}
      else if (character === ',') {offset++; frame.state = 'key';}
      else if (character === '}') {offset++; frames.pop();}
      else invalid();
    } else if (frame.state === 'valueOrEnd' && character === ']') {offset++; frames.pop();}
    else if (frame.state === 'valueOrEnd' || frame.state === 'value') {frame.state = 'after'; value();}
    else if (character === ',') {offset++; frame.state = 'value';}
    else if (character === ']') {offset++; frames.pop();}
    else invalid();
  }
  if (offset !== text.length) invalid();
  // Keep engine-specific parse errors from exposing input if parsing ever differs.
  try {return JSON.parse(text) as unknown;} catch {return invalid();}
}
