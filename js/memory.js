// "Remember this" command parsing + lightweight automatic memory extraction.
export function parseRemember(text) {
  const t = text.trim();
  let m = t.match(/^\/remember\s+([\s\S]+)/i) || t.match(/^(?:please\s+)?remember(?:\s+this)?(?:\s*[:,-]\s*|\s+that\s+)([\s\S]+)/i);
  if (m) return m[1].trim().replace(/\.$/, '');
  return null;
}
export function parseForget(text) {
  const m = text.trim().match(/^(?:\/forget|forget(?:\s+that)?)\s+([\s\S]+)/i);
  return m ? m[1].trim().replace(/\.$/, '') : null;
}

// first-person -> third-person, so memories read well in the system prompt
export function toThirdPerson(s) {
  return s
    .replace(/\bI am\b/gi, 'User is').replace(/\bI'm\b/gi, 'User is').replace(/\bI've\b/gi, 'User has')
    .replace(/\bI\b/g, 'User').replace(/\bmy\b/gi, "user's").replace(/\bme\b/gi, 'user').replace(/\bmine\b/gi, "user's");
}

const PATTERNS = [
  [/\b[Mm]y name is ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)/, m => `User's name is ${m[1]}`],
  [/\b[Cc]all me ([A-Z][\w'-]+)/, m => `User likes to be called ${m[1]}`],
  [/\bI(?:'m| am) (\d{1,2}) (?:years old|yrs old|yo)\b/i, m => `User is ${m[1]} years old`],
  [/\bI(?:'m| am) in (\d{1,2}(?:st|nd|rd|th) grade|(?:middle|high) school|college)\b/i, m => `User is in ${m[1]}`],
  [/\bI live in ([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3})/, m => `User lives in ${m[1]}`],
  [/\bI(?:'m| am) from ([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3})/, m => `User is from ${m[1]}`],
  [/\b[Mm]y (?:favorite|favourite) ([\w ]{2,25}?) is ([^.,!?]{2,40})/, m => `User's favorite ${m[1]} is ${m[2].trim()}`],
  [/\b[Mm]y birthday is ([^.,!?]{3,30})/, m => `User's birthday is ${m[1].trim()}`],
  [/\bI (?:really )?(love|like|enjoy|hate) ([^.,!?]{3,40})/i, m => /^(you|it|that|this|them|when|how|the way)\b/i.test(m[2]) ? null : `User ${m[1].toLowerCase()}s ${m[2].trim()}`],
  [/\bI(?:'m| am) allergic to ([^.,!?]{3,40})/i, m => `User is allergic to ${m[1].trim()}`],
  [/\bI have an? ([\w ]{0,20}?(?:dog|cat|brother|sister|pet|bird|fish|hamster|car|job))\b(?: named ([A-Z]\w+))?/i, m => `User has a ${m[1].trim()}${m[2] ? ` named ${m[2]}` : ''}`],
  [/\bI work (at|as) ([^.,!?]{3,40})/i, m => `User works ${m[1]} ${m[2].trim()}`],
  [/\bI play ([^.,!?]{3,30})/i, m => /^(with|around|games? with)\b/i.test(m[1]) ? null : `User plays ${m[1].trim()}`],
];

export function extractMemories(text) {
  if (!text || text.length > 800) return [];
  const out = [];
  for (const s of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (/\?\s*$/.test(s) || /^(if|what if|imagine|pretend|write|story)\b/i.test(s.trim())) continue;
    for (const [re, fmt] of PATTERNS) {
      const m = s.match(re);
      if (m) { const f = fmt(m); if (f) out.push(f.replace(/[.!,]+$/, '').replace(/\s+(and|but|so)$/i, '')); }
    }
  }
  return [...new Set(out)].slice(0, 5);
}
