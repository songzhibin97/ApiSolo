/**
 * Reads an upload into a base64 string (the data-URL payload, header stripped).
 *
 * A module-level export rather than a private helper inside BodyEditor.vue so
 * the upload-precheck tests can observe whether a file was read at all — the
 * §22 assertions require "an oversized file was never read", and a mockable
 * export is the observable for that. Test infrastructure, not a product
 * concession: the behaviour is byte-for-byte what the component inlined.
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? "")
      const [, base64 = ""] = result.split(",", 2)
      resolve(base64)
    }
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}
