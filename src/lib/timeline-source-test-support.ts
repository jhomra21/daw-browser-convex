import ts from "typescript";

// Parse the shipped bindings, never similarly shaped text in a comment or string.
export const extractTimelineBindings = (source: string) => {
  const file = ts.createSourceFile("Timeline.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const compile: ts.ArrowFunction[] = [];
  const structural: ts.PropertyAssignment[] = [];
  const portable: ts.PropertyAssignment[] = [];
  const mixedReorder: ts.PropertyAssignment[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === "compilePlaybackSnapshot" && node.initializer && ts.isArrowFunction(node.initializer)) {
      compile.push(node.initializer);
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      if (node.name.text === "onStructuralPlaybackChange") structural.push(node);
      if (node.name.text === "applyPortableProcessor") portable.push(node);
      if (node.name.text === "onMixedReorderCommitted") mixedReorder.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const one = <T,>(nodes: readonly T[], name: string): T => {
    const node = nodes[0];
    if (nodes.length !== 1 || !node) throw new Error(`Expected one live ${name} binding, found ${nodes.length}.`);
    return node;
  };
  const body = one(compile, "compilePlaybackSnapshot").body;
  if (!ts.isBlock(body)) throw new Error("Expected the live compile block.");
  const statements = body.statements.flatMap(statement => ts.isTryStatement(statement)
    ? [...statement.tryBlock.statements] : [statement]);
  const boundary = statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "processorStateSequence"));
  if (!boundary) throw new Error("Missing the live compile-prefix boundary.");
  const property = (nodes: readonly ts.PropertyAssignment[], name: string) => {
    const node = one(nodes, name);
    if (!ts.isArrowFunction(node.initializer)) throw new Error(`Expected the live ${name} callback.`);
    return `${node.getText(file)},`;
  };
  return {
    compilePrefix: statements.slice(0, statements.indexOf(boundary)).map(statement => statement.getText(file)).join("\n"),
    structural: property(structural, "onStructuralPlaybackChange"),
    portable: property(portable, "applyPortableProcessor"),
    mixedReorder: property(mixedReorder, "onMixedReorderCommitted"),
  };
};
