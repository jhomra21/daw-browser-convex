export const sanitizeNativeVst3DiagnosticError = (error: Error | undefined) => {
  const message = error?.message ?? "The native VST editor session is unavailable."

  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
}
