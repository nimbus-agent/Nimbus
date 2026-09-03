/**
 * The caption prompts, in ONE place.
 *
 * A prompt change alters what every stored caption says, which is exactly what
 * `UNDERSTANDING_VERSION` (media-types.ts) exists to make re-runnable — so the two must be edited
 * together. Keeping the strings here gives that bump one file to point at.
 *
 * Both prompts ask for OCR text in the SAME call as the description: a VLM's text extraction is
 * materially worse than a purpose-built OCR pass (spec § 12.10), and splitting it into a second
 * call would double the GPU cost without improving that.
 *
 * Both also forbid speculation. A caption is a model's ASSERTION, recorded with
 * `modelDerived: true` so a brief presents it as such (spec § 12.3); a prompt that invited
 * inference would make that flag carry more weight than it can.
 */
export const IMAGE_CAPTION_PROMPT = [
  "Describe this image factually in two to four sentences.",
  "Then, on a new line beginning exactly with 'Visible text:', transcribe any text visible in the",
  "image verbatim. If there is no visible text, write 'Visible text: none'.",
  "Describe only what is visible. Do not speculate about intent, context, or anything outside the frame.",
].join(" ");

export const FRAME_CAPTION_PROMPT = [
  "Describe this single video frame factually in one or two sentences.",
  "Then, on a new line beginning exactly with 'Visible text:', transcribe any text visible in the",
  "frame verbatim. If there is no visible text, write 'Visible text: none'.",
  "Describe only what is visible in this frame. Do not speculate about what happens before or after it.",
].join(" ");
