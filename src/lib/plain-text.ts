/** Strip markdown syntax and `((translation))` reveal markers from a
 *  chat reply, leaving the plain rendered text. Shared by TTS (don't
 *  read asterisks or the hidden translations aloud) and the sentence
 *  analyzer (sentence extraction runs over what the user actually
 *  sees, not the raw markup). */
export function plainTextOf(reply: string): string {
  return reply
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\(\([^()]*\)\)/g, "")
    .replace(/[*_~]+/g, "")
    .replace(/^#+\s*/gm, "");
}
