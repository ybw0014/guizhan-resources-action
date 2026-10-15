// oxlint-disable-next-line no-control-regex -- Cross-platform filenames must reject C0 controls.
export const fileNameRegex = /^(?=[\s\S]+\.[^.]+$)(?![\s\S]*[ .]$)[^\u0000-\u001f<>:"/\\|?*\p{Cs}]+$/u
export const windowsDeviceNameRegex = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])[ ]*(?:\.|$)/i

export function isWithinFilenameByteLimit(value: string) {
  return new TextEncoder().encode(value).byteLength <= 255
}
