// Deterministic check that the user's latest message is an unambiguous "yes".
// Defence in depth for agent-initiated confirmations: even if the model calls the confirm tool
// after "yes, but make it 13 Cr", the backend refuses because the reply is not a clean yes.

const NEGATIVE = /\b(no|nope|nah|not|don'?t|do not|cancel|stop|wait|hold|change|instead|but|wrong|incorrect)\b/;
const POSITIVE =
  /^(yes|y|yeah|yep|yup|ok|okay|sure|confirm|confirmed|correct|right|go ahead|do it|proceed|approve|approved|haan|haan ji|ha|ji|theek hai|please do|looks good|lgtm|add it|update it|save it)\b/;

export function isAffirmative(message: string): boolean {
  const text = message
    .toLowerCase()
    .replace(/[✅\u{1F44D}]/gu, " yes ") // ✅ 👍
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 80) return false;
  if (NEGATIVE.test(text)) return false;
  return POSITIVE.test(text);
}
