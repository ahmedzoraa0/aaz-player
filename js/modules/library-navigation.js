/**
 * Android Hierarchical Media Library Navigator.
 *
 * File-manager style browsing for SAF folder grants: the library root lists
 * the granted trees, tapping a folder shows its immediate children
 * (subfolders first, then that folder's media files only — never a recursive
 * flatten), and Back goes up one level before leaving the library.
 *
 * This module is the pure navigation state machine (Node-testable). Data
 * fetching (one directory level at a time via
 * DocumentsContract.buildChildDocumentsUriUsingTree) is injected by the
 * caller; desktop keeps its flat library UX and never uses this module.
 */

export function createLibraryNavigator() {
  // roots: [{ treeUri, name }]
  let roots = [];
  // stack: [{ docId, name }] — empty means the roots view. The first entry is
  // the tree root (docId '' = the tree's root document).
  let stack = [];
  // activeRoot: treeUri of the tree currently being browsed ('' in roots view)
  let activeRoot = '';

  function setRoots(list) {
    roots = (Array.isArray(list) ? list : [])
      .filter((r) => r && r.treeUri)
      .map((r) => ({ treeUri: String(r.treeUri), name: String(r.name || r.treeUri) }));
    if (activeRoot && !roots.some((r) => r.treeUri === activeRoot)) {
      resetToRoots();
    }
  }

  function getRoots() {
    return roots.slice();
  }

  function isBrowsing() {
    return stack.length > 0;
  }

  function canGoUp() {
    return stack.length > 0;
  }

  function enterRoot(treeUri) {
    const root = roots.find((r) => r.treeUri === treeUri);
    if (!root) return false;
    activeRoot = root.treeUri;
    stack = [{ docId: '', name: root.name }];
    return true;
  }

  function openFolder(folder) {
    if (!isBrowsing() || !folder || !folder.docId) return false;
    stack.push({ docId: String(folder.docId), name: String(folder.name || folder.docId) });
    return true;
  }

  /**
   * Go up one level. Returns true when a level was consumed (caller must
   * re-render and swallow the Back press), false when already at the roots
   * view (caller should continue its normal back behavior).
   */
  function goUp() {
    if (stack.length > 1) {
      stack.pop();
      return true;
    }
    if (stack.length === 1) {
      stack = [];
      activeRoot = '';
      return true;
    }
    return false;
  }

  function resetToRoots() {
    stack = [];
    activeRoot = '';
  }

  /** Breadcrumb segments, root first. Empty in the roots view. */
  function getBreadcrumbs() {
    return stack.map((seg, idx) => ({ docId: seg.docId, name: seg.name, depth: idx }));
  }

  /** docId to pass to the native one-level listing ('' = tree root), or null in roots view. */
  function getCurrentDocId() {
    return isBrowsing() ? stack[stack.length - 1].docId : null;
  }

  function getActiveTreeUri() {
    return isBrowsing() ? activeRoot : null;
  }

  /** Jump straight to a breadcrumb depth (0 = tree root). */
  function jumpToDepth(depth) {
    const d = Math.floor(Number(depth));
    if (!Number.isFinite(d) || d < 0 || d >= stack.length) return false;
    stack = stack.slice(0, d + 1);
    return true;
  }

  /**
   * Order one directory level for display: subfolders first, then media
   * files, each alphabetical (numeric-aware, case-insensitive).
   */
  function sortLevel(folders, files) {
    const byName = (a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    return {
      folders: (Array.isArray(folders) ? folders.slice() : []).sort(byName),
      files: (Array.isArray(files) ? files.slice() : []).sort(byName),
    };
  }

  return {
    setRoots,
    getRoots,
    isBrowsing,
    canGoUp,
    enterRoot,
    openFolder,
    goUp,
    resetToRoots,
    getBreadcrumbs,
    getCurrentDocId,
    getActiveTreeUri,
    jumpToDepth,
    sortLevel,
  };
}
