const indexes = new WeakMap();
const empty = Object.freeze([]);
/** Page membership/order changes rebuild once; geometry edits use live objects. */
export function annotationsForPage(doc, pageNum) {
  if (!doc) return empty;
  const annotations = doc.annotations || empty;
  const revision = Number(doc.revisionState?.contentRevision) || 0;
  let index = indexes.get(doc);
  if (!index || index.annotations !== annotations || index.count !== annotations.length || index.revision !== revision) {
    const pages = new Map();
    for (const annotation of annotations) {
      const number = Number(annotation.page);
      let page = pages.get(number);
      if (!page) { page = []; pages.set(number, page); }
      page.push(annotation);
    }
    index = { annotations, count: annotations.length, revision, pages };
    indexes.set(doc, index);
  }
  return index.pages.get(Number(pageNum)) || empty;
}
export function invalidateAnnotationPageIndex(doc) { if (doc) indexes.delete(doc); }
