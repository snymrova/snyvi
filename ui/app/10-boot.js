/* ui/app/10-boot.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
  // ---------- boot ----------
  // The sidebar's sections in the reader's order, before anything measures them.
  drawWidgets();
  if (state.view === "doc" && state.doc) {
    // Opened from a link -- an agent's, or the notification's -- so it is read.
    markRead(state.doc.id);
    // A page or a PDF opens as itself here too, not only from the sidebar.
    setPreview(boot.preview, boot.preview_url, "d:" + state.doc.id); applyPreview();
    document.title = state.doc.title; afterRender(); history.replaceState({ id: state.doc.id }, "", location.pathname + location.hash);
    // A link to a section: the browser's own fragment scroll aimed at a
    // placeholder, the same way a smooth scroll does. Land it properly.
    if (location.hash && !lineHash()) jumpToHash();
    // Opened afresh -- a restart, a link -- it goes back to where it was left.
    else if (!location.hash) { const was = places()[placeKey(state.doc)]; if (was && !was.end && was.i >= 0) placeAt(was); }
  }
  else if (state.view === "browse" && state.browseRoot) { showBrowse(state.browseRoot.id, state.browsePath, false); history.replaceState({ browse: state.browseRoot.id, path: state.browsePath }, "", location.pathname + location.hash); }
  else if (state.view === "connect") { showConnect(false); history.replaceState({ connect: true }, "", "/connect"); }
  else if (state.view === "sidebars") { history.replaceState({ sidebars: true }, "", "/sidebars"); showSidebars(false); }
  else if (state.view === "start") { history.replaceState({ start: true }, "", "/start" + location.hash); showStart(false); }
  else if (state.view === "welcome") { history.replaceState({ welcome: true }, "", "/welcome"); showWelcome(false); }
  else if (state.view === "desk") { history.replaceState({ desk: boot.desk }, "", location.pathname); showDesk(boot.desk, false); }
  else if (state.view === "home") { history.replaceState({ home: true }, "", "/"); showHome(false); }
  else { showInbox(false); history.replaceState({ inbox: true }, "", location.pathname === "/" ? "/" : "/inbox"); }
  connect();
  loadDesks();
