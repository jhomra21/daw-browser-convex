import ts from "typescript"
import { z } from "zod"
import { openAcceptanceInspector, parseSpoolEvaluation } from "./native-spool-observer"
import { installLateCommitObservation } from "./late-commit-observation-runtime"
import { waitForAcceptanceEvent } from "./native-acceptance-ui"

// Property names survive minification. Fail closed rather than guessing local
// variable names, mutating contextBridge, or depending on a stale package hash.
type InstrumentedLateCommitScript = { source: string; controllers: number; leaseCalls: number }

export const instrumentLateCommitScript = (source: string, startupDiagnostics = false): InstrumentedLateCommitScript => {
  const tree = ts.createSourceFile("packaged.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const edits: { start: number; end: number; text: string }[] = []
  const registrationCalls: ts.CallExpression[] = []
  let controllers = 0
  let leaseCalls = 0
  const visit = (node: ts.Node) => {
    if (startupDiagnostics && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === "setRequestHandler" || node.expression.name.text === "onPrepareToClose")) {
      registrationCalls.push(node)
    }
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)
      && node.expression.properties.some((property) => ts.isPropertyAssignment(property)
        && property.name.getText(tree) === "isPrepared")) {
      let parent: ts.Node | undefined = node.parent
      while (parent && !ts.isArrowFunction(parent) && !ts.isFunctionDeclaration(parent)) parent = parent.parent
      if (!parent || (!ts.isArrowFunction(parent) && !ts.isFunctionDeclaration(parent))
        || !parent.body || !ts.isBlock(parent.body) || parent.parameters.length !== 1
        || !parent.parameters[0] || !ts.isIdentifier(parent.parameters[0].name))
        throw new Error("Unambiguous native controller factory unavailable.")
      const body = parent.body.getText(tree)
      if (!body.includes(".commitTransaction(")) return
      if (!body.includes("getPendingStart:")) throw new Error("Unexpected native controller contract.")
      controllers++
      const argument = parent.parameters[0].name.text
      if (!startupDiagnostics) {
        edits.push({ start: parent.body.getStart(tree) + 1, end: parent.body.getStart(tree) + 1,
          text: `${argument}=globalThis.__dawLateCommitObservation.input(${argument});` })
        edits.push({ start: node.expression.getStart(tree), end: node.expression.getStart(tree),
          // Minified bundles emit `return{...}`; without the space this becomes `returnglobalThis`.
          text: " globalThis.__dawLateCommitObservation.controller(" })
        edits.push({ start: node.expression.end, end: node.expression.end, text: ")" })
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "acquireLease") {
      leaseCalls++
      if (!startupDiagnostics) {
        edits.push({ start: node.getStart(tree), end: node.getStart(tree),
          text: "globalThis.__dawLateCommitObservation.lease(()=>" })
        edits.push({ start: node.end, end: node.end, text: ")" })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (controllers !== 1 || leaseCalls !== 2)
    throw new Error("Expected one controller and two Stretch lease call boundaries.")
  if (startupDiagnostics) {
    const [setActive, closeActive, setInactive, closeInactive] = registrationCalls
    const pair = (first: ts.CallExpression | undefined, second: ts.CallExpression | undefined) => {
      if (!first || !second || !ts.isBinaryExpression(first.parent) || first.parent !== second.parent
        || first.parent.operatorToken.kind !== ts.SyntaxKind.CommaToken
        || first.parent.left !== first || first.parent.right !== second
        || !ts.isPropertyAccessExpression(first.expression) || !ts.isPropertyAccessExpression(second.expression)
        || first.expression.expression.getText(tree) !== "window.dawDesktop"
        || second.expression.expression.getText(tree) !== "window.dawDesktop") return undefined
      return first.parent
    }
    const activePair = pair(setActive, closeActive)
    const activeSequence = activePair && ts.isBinaryExpression(activePair.parent) ? activePair.parent : undefined
    const teardownOwner = (node: ts.Node | undefined) => {
      let parent = node?.parent
      while (parent && !ts.isArrowFunction(parent)) parent = parent.parent
      return parent
    }
    const inactiveArgument = setInactive?.arguments[0]
    const activeCloseArgument = closeActive?.arguments[0]
    const inactiveSetArgument = setInactive?.arguments[0]
    const inactiveCloseArgument = closeInactive?.arguments[0]
    if (registrationCalls.length !== 4 || !setActive || !closeActive || !setInactive || !closeInactive
      || !activePair || !activeSequence
      || activePair.left !== setActive || activePair.right !== closeActive
      || setActive.arguments.length !== 2 || closeActive.arguments.length !== 1
      || setInactive.arguments.length !== 1 || closeInactive.arguments.length !== 1
      || !ts.isBinaryExpression(setInactive.parent) || setInactive.parent.operatorToken.kind !== ts.SyntaxKind.CommaToken
      || !ts.isBinaryExpression(closeInactive.parent) || closeInactive.parent.operatorToken.kind !== ts.SyntaxKind.CommaToken
      || !ts.isPropertyAccessExpression(setInactive.expression) || !ts.isPropertyAccessExpression(closeInactive.expression)
      || setInactive.expression.expression.getText(tree) !== "window.dawDesktop"
      || closeInactive.expression.expression.getText(tree) !== "window.dawDesktop"
      || setInactive.getStart(tree) <= closeActive.end
      || !teardownOwner(setInactive) || teardownOwner(setInactive) !== teardownOwner(closeInactive)
      || teardownOwner(setInactive) !== activeSequence.right
      || !inactiveArgument || !ts.isVoidExpression(inactiveArgument)
      || inactiveArgument.expression.getText(tree) !== "0"
      || !activeCloseArgument || !ts.isArrowFunction(activeCloseArgument)
      || activeSequence.operatorToken.kind !== ts.SyntaxKind.CommaToken
      || activeSequence.left !== activePair || !ts.isArrowFunction(activeSequence.right)
      || !ts.isReturnStatement(activeSequence.parent)
      || !inactiveSetArgument || !ts.isVoidExpression(inactiveSetArgument)
      || inactiveSetArgument.expression.getText(tree) !== "0"
      || !inactiveCloseArgument || !ts.isVoidExpression(inactiveCloseArgument)
      || inactiveCloseArgument.expression.getText(tree) !== "0")
      throw new Error("Unambiguous packaged registration sequence unavailable.")
    edits.push({
      start: closeActive.end,
      end: closeActive.end,
      text: ",globalThis.__dawLateCommitObservation?.registrationReturned?.()",
    })
  }
  let observed = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    observed = observed.slice(0, edit.start) + edit.text + observed.slice(edit.end)
  }
  const transformed = "globalThis.__dawLateCommitObservation.scriptInstalled();" + observed
  if (startupDiagnostics
    && (ts.transpileModule(transformed, { compilerOptions: { target: ts.ScriptTarget.Latest }, reportDiagnostics: true })
      .diagnostics?.length ?? 0) > 0)
    throw new Error("Startup observer transformed script failed to parse.")
  return { source: transformed, controllers, leaseCalls }
}

export class StartupObservationInterrupted extends Error {
  constructor(readonly diagnostics: {
    registrationReturned: boolean;
    exceptionOverflow: boolean;
    exceptions: { occurrence: number; category: "TypeError" | "RangeError" | "SyntaxError" | "Error" | "unknown" }[];
  }, readonly reason: "exception" | "observer-failure") {
    super("Startup observer interrupted.")
  }
}

export const installLateCommitObserver = async (endpoint: string, startupDiagnostics = false) => {
  const inspector = await openAcceptanceInspector(endpoint)
  const nonce = crypto.randomUUID()
  const binding = `__lateCommitReady_${nonce.replaceAll("-", "")}`
  const registrationSignal = startupDiagnostics
    ? `,()=>{try{const callback=globalThis[${JSON.stringify(binding)}];if(typeof callback==="function")callback(${JSON.stringify(`${nonce}:registration-returned`)})}catch{}}` : ""
  const bootstrap = ts.transpileModule(`(${installLateCommitObservation.toString()})(${JSON.stringify(nonce)},()=>globalThis[${JSON.stringify(binding)}](${JSON.stringify(nonce)})${registrationSignal})`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText
  let bootstrapId = ""
  let changed = 0
  let failure: Error | undefined
  let mainFrameId = ""
  let currentContextId: number | undefined
  let reloadStarted = false
  let newDocumentNavigated = false
  let registrationReturned = false
  let exceptionOverflow = false
  const exceptions: { occurrence: number; category: "TypeError" | "RangeError" | "SyntaxError" | "Error" | "unknown" }[] = []
  const diagnosticInterruption = Promise.withResolvers<"exception" | "observer-failure">()
  let interruptionReported = false
  let interruptionReason: "exception" | "observer-failure" | undefined
  const interrupt = (reason: "exception" | "observer-failure") => {
    if (startupDiagnostics && !interruptionReported) {
      interruptionReported = true
      interruptionReason = reason
      diagnosticInterruption.resolve(reason)
    }
  }
  const intercepted = Promise.withResolvers<void>()
  const scriptReady = Promise.withResolvers<true>()
  // The rejected interception is joined below, including when reload fails.
  void intercepted.promise.catch(() => undefined)
  const unlisten = inspector.listen((message) => {
    if (message.method === "Runtime.bindingCalled") {
      if (!startupDiagnostics && message.params?.name === binding && message.params.payload === nonce)
        scriptReady.resolve(true)
      if (startupDiagnostics) {
        const call = z.object({
          name: z.string(), payload: z.string(), executionContextId: z.number(),
        }).safeParse(message.params)
        if (call.success && call.data.name === binding && newDocumentNavigated
          && call.data.executionContextId === currentContextId) {
          if (call.data.payload === nonce) scriptReady.resolve(true)
          else if (call.data.payload === `${nonce}:registration-returned`) registrationReturned = true
        }
      }
    }
    if (startupDiagnostics && message.method === "Page.frameNavigated") {
      const frame = z.object({ id: z.string(), parentId: z.string().optional() }).safeParse(message.params?.frame)
      if (frame.success && frame.data.id === mainFrameId && frame.data.parentId === undefined) {
        newDocumentNavigated = reloadStarted
        currentContextId = undefined
      }
    }
    if (startupDiagnostics && message.method === "Page.frameStartedLoading") {
      const frame = z.object({ frameId: z.string() }).safeParse(message.params)
      if (frame.success && frame.data.frameId === mainFrameId) {
        newDocumentNavigated = reloadStarted
        currentContextId = undefined
      }
    }
    if (startupDiagnostics && message.method === "Runtime.executionContextCreated") {
      const context = z.object({ id: z.number(), auxData: z.object({
        frameId: z.string().optional(), isDefault: z.boolean().optional(),
      }).passthrough().optional() }).safeParse(message.params?.context)
      if (context.success && newDocumentNavigated && context.data.auxData?.frameId === mainFrameId
        && context.data.auxData.isDefault === true) currentContextId = context.data.id
    }
    if (startupDiagnostics && message.method === "Runtime.executionContextDestroyed") {
      const destroyed = z.object({ executionContextId: z.number() }).safeParse(message.params)
      if (destroyed.success && destroyed.data.executionContextId === currentContextId)
        currentContextId = undefined
    }
    if (startupDiagnostics && message.method === "Runtime.exceptionThrown") {
      const details = z.object({ executionContextId: z.number().optional(), exception: z.object({
        className: z.string().optional(), type: z.string().optional(), subtype: z.string().optional(),
      }).passthrough().optional() }).passthrough().safeParse(message.params?.exceptionDetails)
      if (!details.success) {
        interrupt("observer-failure")
      } else if (details.data.executionContextId !== undefined && reloadStarted && currentContextId !== undefined
        && details.data.executionContextId === currentContextId) {
        const className = details.data.exception?.className
        const category = className === "TypeError" || className === "RangeError" || className === "SyntaxError"
          ? className : className === "Error" || details.data.exception?.subtype === "error" ? "Error" : "unknown"
        if (exceptions.length < 30) exceptions.push({ occurrence: exceptions.length + 1, category })
        else exceptionOverflow = true
        interrupt("exception")
      }
    }
    if (message.method !== "Fetch.requestPaused") return
    void (async () => {
      const paused = z.object({ requestId: z.string(), responseStatusCode: z.number() }).parse(message.params)
      const response = z.object({ body: z.string(), base64Encoded: z.boolean() }).parse(
        await inspector.send("Fetch.getResponseBody", { requestId: paused.requestId }))
      const original = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body
      const transformed = instrumentLateCommitScript(original, startupDiagnostics)
      if (++changed !== 1) throw new Error("Repeated late Commit script interception.")
      await inspector.send("Fetch.fulfillRequest", { requestId: paused.requestId, responseCode: paused.responseStatusCode,
        responseHeaders: [{ name: "Content-Type", value: "text/javascript" }],
        body: Buffer.from(transformed.source).toString("base64") })
      intercepted.resolve()
    })().catch((error) => {
      failure = error instanceof Error ? error : new Error("Late Commit script interception failed.")
      intercepted.reject(failure)
      interrupt("observer-failure")
    })
  })
  const invoke = async (operation: string) => JSON.parse(parseSpoolEvaluation(await inspector.send("Runtime.evaluate", {
    expression: `globalThis.__dawLateCommitObservation.invoke(${JSON.stringify(nonce)},${JSON.stringify(operation)})`,
    returnByValue: true, awaitPromise: true,
  })))
  const close = async () => {
    try {
      if (!startupDiagnostics) {
        await invoke("release").catch(() => undefined)
        await invoke("settle").catch(() => undefined)
        await invoke("close").catch(() => undefined)
      }
      unlisten()
      await Promise.allSettled([
        inspector.send("Fetch.disable"),
        inspector.send("Runtime.removeBinding", { name: binding }),
        ...(bootstrapId ? [inspector.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: bootstrapId })] : []),
      ])
      await inspector.send("Runtime.evaluate", {
        expression: "delete globalThis.__dawLateCommitObservation", returnByValue: true,
      }).catch(() => undefined)
    } finally { inspector.close() }
  }
  try {
    await inspector.send("Runtime.enable")
    await inspector.send("Runtime.addBinding", { name: binding })
    await inspector.send("Page.enable")
    if (startupDiagnostics) {
      const frameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }).passthrough() }).passthrough() })
        .parse(await inspector.send("Page.getFrameTree"))
      mainFrameId = frameTree.frameTree.frame.id
    }
    bootstrapId = z.string().parse((await inspector.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap })).identifier)
    await inspector.send("Fetch.enable", { patterns: [{ urlPattern: "daw://app/*index-*.js", requestStage: "Response" }] })
    if (startupDiagnostics) {
      reloadStarted = true
      newDocumentNavigated = false
      currentContextId = undefined
      await Promise.race([
        inspector.send("Page.reload", { ignoreCache: true }),
        diagnosticInterruption.promise.then((reason) => {
          throw new StartupObservationInterrupted({
            registrationReturned, exceptionOverflow, exceptions: [...exceptions],
          }, reason)
        }),
      ])
    } else await inspector.send("Page.reload", { ignoreCache: true })
    // Authenticated new-document binding avoids evaluating in the old context
    // immediately after reload. Reuse the existing bounded acceptance deadline.
    if (startupDiagnostics) {
      const ready = await Promise.race([
        waitForAcceptanceEvent(scriptReady.promise, 15000).then((complete): "script-ready" | "script-ready-deadline" =>
          complete ? "script-ready" : "script-ready-deadline"),
        diagnosticInterruption.promise,
      ])
      if (ready === "exception" || ready === "observer-failure")
        throw new StartupObservationInterrupted({
          registrationReturned, exceptionOverflow, exceptions: [...exceptions],
        }, ready)
      if (ready === "script-ready-deadline") throw new Error("Packaged script-ready observation deadline.")
    } else if (!await waitForAcceptanceEvent(scriptReady.promise, 15000))
      throw new Error("Packaged script-ready observation deadline.")
    if (failure) throw failure
    if (changed !== 1) throw new Error("Packaged controller script was not intercepted.")
    await intercepted.promise
    await inspector.send("Fetch.disable")
    if (interruptionReason)
      throw new StartupObservationInterrupted({
        registrationReturned, exceptionOverflow, exceptions: [...exceptions],
      }, interruptionReason)
    return {
      invoke, close, closed: inspector.closed,
      diagnosticInterruption: diagnosticInterruption.promise,
      diagnosticInterrupted: () => interruptionReason,
      diagnosticSnapshot: () => ({
        registrationReturned, exceptionOverflow, exceptions: [...exceptions],
      }),
    }
  } catch (error) {
    await close().catch(() => inspector.close())
    if (startupDiagnostics && !(error instanceof StartupObservationInterrupted))
      throw new StartupObservationInterrupted({
        registrationReturned, exceptionOverflow, exceptions: [...exceptions],
      }, "observer-failure")
    throw error
  }
}
