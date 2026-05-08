/**
 * Market Signal Platform — Chat Widget
 *
 * Self-contained JavaScript embed snippet. No external dependencies.
 * Founders embed this on any web page to activate the in-app chat widget:
 *
 *   <script src="https://cdn.marketsignal.io/widget.js"
 *           data-project-id="proj_xxx"
 *           data-campaign-id="camp_xxx">
 *   </script>
 *
 * The widget:
 *  - Reads data-project-id and data-campaign-id from the script tag
 *  - Renders a floating chat button (bottom-right)
 *  - Opens a chat panel when clicked
 *  - Creates a session via POST /api/widget/session
 *  - Sends messages via POST /api/widget/message
 *  - Polls for new messages via GET /api/widget/messages?sessionId=xxx
 *
 * Requirements: 11.3, 11.4
 */
(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────────────

  /** Resolve the API base URL from the script tag's src attribute. */
  var scriptTag = document.currentScript || (function () {
    var scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();

  var projectId = scriptTag.getAttribute("data-project-id");
  var campaignId = scriptTag.getAttribute("data-campaign-id");

  if (!projectId || !campaignId) {
    console.warn("[MarketSignal Widget] Missing data-project-id or data-campaign-id attribute.");
    return;
  }

  /** Derive the API base URL from the script src (strip /widget.js) */
  var scriptSrc = scriptTag.src || "";
  var apiBase = scriptSrc.replace(/\/widget\.js(\?.*)?$/, "");
  if (!apiBase) {
    apiBase = window.location.origin;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  var sessionId = null;
  var isOpen = false;
  var isLoading = false;
  var pollInterval = null;
  var lastMessageCount = 0;

  /** @type {Array<{role: 'user'|'assistant', content: string, id: string}>} */
  var messages = [];

  // ── Styles ─────────────────────────────────────────────────────────────────

  var STYLES = [
    /* Reset & base */
    "#ms-widget-btn,#ms-widget-panel,#ms-widget-panel *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}",

    /* Floating button */
    "#ms-widget-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#4f46e5;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(79,70,229,.45);display:flex;align-items:center;justify-content:center;z-index:2147483646;transition:transform .2s,box-shadow .2s;}",
    "#ms-widget-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(79,70,229,.55);}",
    "#ms-widget-btn svg{pointer-events:none;}",

    /* Panel */
    "#ms-widget-panel{position:fixed;bottom:92px;right:24px;width:360px;max-width:calc(100vw - 48px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.18);display:flex;flex-direction:column;z-index:2147483645;overflow:hidden;transition:opacity .2s,transform .2s;}",
    "#ms-widget-panel.ms-hidden{opacity:0;transform:translateY(12px) scale(.97);pointer-events:none;}",

    /* Header */
    "#ms-widget-header{background:#4f46e5;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}",
    "#ms-widget-header h3{margin:0;font-size:15px;font-weight:600;line-height:1.3;}",
    "#ms-widget-header p{margin:4px 0 0;font-size:12px;opacity:.8;}",
    "#ms-widget-close{background:none;border:none;color:#fff;cursor:pointer;padding:4px;border-radius:6px;display:flex;align-items:center;opacity:.8;transition:opacity .15s;}",
    "#ms-widget-close:hover{opacity:1;}",

    /* Messages area */
    "#ms-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}",
    "#ms-widget-messages::-webkit-scrollbar{width:4px;}",
    "#ms-widget-messages::-webkit-scrollbar-track{background:transparent;}",
    "#ms-widget-messages::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:2px;}",

    /* Message bubbles */
    ".ms-msg{max-width:80%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.5;word-break:break-word;}",
    ".ms-msg-user{align-self:flex-end;background:#4f46e5;color:#fff;border-bottom-right-radius:4px;}",
    ".ms-msg-assistant{align-self:flex-start;background:#f3f4f6;color:#111827;border-bottom-left-radius:4px;}",
    ".ms-msg-system{align-self:center;background:transparent;color:#9ca3af;font-size:12px;text-align:center;}",

    /* Typing indicator */
    "#ms-widget-typing{align-self:flex-start;padding:10px 14px;background:#f3f4f6;border-radius:14px;border-bottom-left-radius:4px;display:none;}",
    "#ms-widget-typing span{display:inline-block;width:6px;height:6px;background:#9ca3af;border-radius:50%;margin:0 2px;animation:ms-bounce .9s infinite;}",
    "#ms-widget-typing span:nth-child(2){animation-delay:.15s;}",
    "#ms-widget-typing span:nth-child(3){animation-delay:.3s;}",
    "@keyframes ms-bounce{0%,80%,100%{transform:translateY(0);}40%{transform:translateY(-6px);}}",

    /* Input area */
    "#ms-widget-input-area{padding:12px 16px;border-top:1px solid #e5e7eb;display:flex;gap:8px;flex-shrink:0;background:#fff;}",
    "#ms-widget-input{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:9px 12px;font-size:14px;outline:none;resize:none;line-height:1.4;max-height:100px;overflow-y:auto;transition:border-color .15s;}",
    "#ms-widget-input:focus{border-color:#4f46e5;}",
    "#ms-widget-input:disabled{background:#f9fafb;color:#9ca3af;}",
    "#ms-widget-send{background:#4f46e5;color:#fff;border:none;border-radius:10px;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s;}",
    "#ms-widget-send:hover:not(:disabled){background:#4338ca;}",
    "#ms-widget-send:disabled{background:#a5b4fc;cursor:not-allowed;}",

    /* Powered by */
    "#ms-widget-footer{text-align:center;padding:6px;font-size:11px;color:#d1d5db;flex-shrink:0;}",
    "#ms-widget-footer a{color:#d1d5db;text-decoration:none;}",
    "#ms-widget-footer a:hover{color:#9ca3af;}",
  ].join("");

  // ── DOM helpers ────────────────────────────────────────────────────────────

  function injectStyles() {
    var style = document.createElement("style");
    style.id = "ms-widget-styles";
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  function createButton() {
    var btn = document.createElement("button");
    btn.id = "ms-widget-btn";
    btn.setAttribute("aria-label", "Open chat");
    btn.setAttribute("title", "Chat with us");
    btn.innerHTML = [
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
      '<path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z" fill="currentColor"/>',
      "</svg>",
    ].join("");
    btn.addEventListener("click", togglePanel);
    return btn;
  }

  function createPanel() {
    var panel = document.createElement("div");
    panel.id = "ms-widget-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat panel");
    panel.setAttribute("aria-modal", "true");
    panel.classList.add("ms-hidden");

    panel.innerHTML = [
      '<div id="ms-widget-header">',
      '  <div>',
      '    <h3>Chat with us</h3>',
      '    <p>We typically reply instantly</p>',
      '  </div>',
      '  <button id="ms-widget-close" aria-label="Close chat">',
      '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
      '      <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      '    </svg>',
      '  </button>',
      '</div>',
      '<div id="ms-widget-messages" role="log" aria-live="polite" aria-label="Chat messages">',
      '  <div id="ms-widget-typing" aria-label="Assistant is typing">',
      '    <span></span><span></span><span></span>',
      '  </div>',
      '</div>',
      '<div id="ms-widget-input-area">',
      '  <textarea id="ms-widget-input" placeholder="Type a message…" rows="1" aria-label="Message input"></textarea>',
      '  <button id="ms-widget-send" aria-label="Send message" disabled>',
      '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
      '      <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      '    </svg>',
      '  </button>',
      '</div>',
      '<div id="ms-widget-footer">',
      '  Powered by <a href="https://marketsignal.io" target="_blank" rel="noopener noreferrer">MarketSignal</a>',
      '</div>',
    ].join("");

    return panel;
  }

  // ── API helpers ────────────────────────────────────────────────────────────

  /**
   * POST /api/widget/session — create a new chat session.
   * Returns { sessionId: string }
   */
  function createSession() {
    return fetch(apiBase + "/api/widget/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: projectId, campaignId: campaignId }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to create session: " + res.status);
        return res.json();
      })
      .then(function (data) {
        return data.sessionId;
      });
  }

  /**
   * POST /api/widget/message — send a user message.
   * Returns { messageId: string, reply: string }
   */
  function sendMessage(content) {
    return fetch(apiBase + "/api/widget/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionId,
        content: content,
        projectId: projectId,
        campaignId: campaignId,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to send message: " + res.status);
        return res.json();
      });
  }

  /**
   * GET /api/widget/messages?sessionId=xxx — poll for messages.
   * Returns { messages: Array<{id, role, content, createdAt}> }
   */
  function fetchMessages() {
    return fetch(
      apiBase + "/api/widget/messages?sessionId=" + encodeURIComponent(sessionId),
      { method: "GET" }
    )
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to fetch messages: " + res.status);
        return res.json();
      })
      .then(function (data) {
        return data.messages || [];
      });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function getMessagesContainer() {
    return document.getElementById("ms-widget-messages");
  }

  function getInput() {
    return document.getElementById("ms-widget-input");
  }

  function getSendButton() {
    return document.getElementById("ms-widget-send");
  }

  function getTypingIndicator() {
    return document.getElementById("ms-widget-typing");
  }

  function scrollToBottom() {
    var container = getMessagesContainer();
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function showTyping() {
    var typing = getTypingIndicator();
    if (typing) {
      typing.style.display = "block";
      scrollToBottom();
    }
  }

  function hideTyping() {
    var typing = getTypingIndicator();
    if (typing) {
      typing.style.display = "none";
    }
  }

  function appendMessage(role, content, id) {
    var container = getMessagesContainer();
    if (!container) return;

    var div = document.createElement("div");
    div.className = "ms-msg ms-msg-" + role;
    if (id) div.setAttribute("data-msg-id", id);
    div.textContent = content;

    // Insert before the typing indicator
    var typing = getTypingIndicator();
    if (typing) {
      container.insertBefore(div, typing);
    } else {
      container.appendChild(div);
    }

    scrollToBottom();
  }

  function appendSystemMessage(text) {
    var container = getMessagesContainer();
    if (!container) return;

    var div = document.createElement("div");
    div.className = "ms-msg ms-msg-system";
    div.textContent = text;

    var typing = getTypingIndicator();
    if (typing) {
      container.insertBefore(div, typing);
    } else {
      container.appendChild(div);
    }

    scrollToBottom();
  }

  function setInputDisabled(disabled) {
    var input = getInput();
    var send = getSendButton();
    if (input) input.disabled = disabled;
    if (send) send.disabled = disabled;
  }

  function updateSendButtonState() {
    var input = getInput();
    var send = getSendButton();
    if (!input || !send) return;
    send.disabled = input.disabled || input.value.trim().length === 0;
  }

  // ── Session & polling ──────────────────────────────────────────────────────

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(function () {
      if (!sessionId) return;
      fetchMessages()
        .then(function (msgs) {
          if (msgs.length > lastMessageCount) {
            // Render any new messages
            for (var i = lastMessageCount; i < msgs.length; i++) {
              var msg = msgs[i];
              // Only render assistant messages here (user messages are rendered immediately on send)
              if (msg.role === "assistant") {
                appendMessage("assistant", msg.content, msg.id);
              }
            }
            lastMessageCount = msgs.length;
          }
        })
        .catch(function (err) {
          console.warn("[MarketSignal Widget] Poll error:", err.message);
        });
    }, 3000); // Poll every 3 seconds
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function initSession() {
    setInputDisabled(true);
    appendSystemMessage("Connecting…");

    createSession()
      .then(function (sid) {
        sessionId = sid;

        // Clear the "Connecting…" message
        var container = getMessagesContainer();
        if (container) {
          var systemMsgs = container.querySelectorAll(".ms-msg-system");
          systemMsgs.forEach(function (el) { el.remove(); });
        }

        appendSystemMessage("Hi! How can we help you today?");
        setInputDisabled(false);
        updateSendButtonState();
        startPolling();
      })
      .catch(function (err) {
        console.error("[MarketSignal Widget] Session init failed:", err.message);
        var container = getMessagesContainer();
        if (container) {
          var systemMsgs = container.querySelectorAll(".ms-msg-system");
          systemMsgs.forEach(function (el) { el.remove(); });
        }
        appendSystemMessage("Unable to connect. Please try again later.");
      });
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  function handleSend() {
    var input = getInput();
    if (!input) return;

    var content = input.value.trim();
    if (!content || !sessionId || isLoading) return;

    isLoading = true;
    input.value = "";
    updateSendButtonState();
    setInputDisabled(true);

    // Render user message immediately
    appendMessage("user", content);
    lastMessageCount += 1;

    showTyping();

    sendMessage(content)
      .then(function (data) {
        hideTyping();
        if (data.reply) {
          appendMessage("assistant", data.reply);
          lastMessageCount += 1;
        }
        isLoading = false;
        setInputDisabled(false);
        updateSendButtonState();
        getInput() && getInput().focus();
      })
      .catch(function (err) {
        hideTyping();
        console.error("[MarketSignal Widget] Send failed:", err.message);
        appendSystemMessage("Message failed to send. Please try again.");
        isLoading = false;
        setInputDisabled(false);
        updateSendButtonState();
      });
  }

  function handleKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput() {
    // Auto-resize textarea
    var input = getInput();
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 100) + "px";
    updateSendButtonState();
  }

  // ── Panel toggle ───────────────────────────────────────────────────────────

  function openPanel() {
    var panel = document.getElementById("ms-widget-panel");
    var btn = document.getElementById("ms-widget-btn");
    if (!panel || !btn) return;

    isOpen = true;
    panel.classList.remove("ms-hidden");
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-label", "Close chat");
    btn.innerHTML = [
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
      '<path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>',
      "</svg>",
    ].join("");

    // Initialize session on first open
    if (!sessionId) {
      initSession();
    } else {
      var input = getInput();
      if (input && !input.disabled) input.focus();
    }
  }

  function closePanel() {
    var panel = document.getElementById("ms-widget-panel");
    var btn = document.getElementById("ms-widget-btn");
    if (!panel || !btn) return;

    isOpen = false;
    panel.classList.add("ms-hidden");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open chat");
    btn.innerHTML = [
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
      '<path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z" fill="currentColor"/>',
      "</svg>",
    ].join("");
  }

  function togglePanel() {
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  // ── Keyboard accessibility ─────────────────────────────────────────────────

  function handleDocumentKeydown(e) {
    if (e.key === "Escape" && isOpen) {
      closePanel();
      var btn = document.getElementById("ms-widget-btn");
      if (btn) btn.focus();
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Inject styles
    injectStyles();

    // Create and mount DOM elements
    var btn = createButton();
    var panel = createPanel();

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    // Wire up close button
    var closeBtn = document.getElementById("ms-widget-close");
    if (closeBtn) closeBtn.addEventListener("click", closePanel);

    // Wire up send button
    var sendBtn = document.getElementById("ms-widget-send");
    if (sendBtn) sendBtn.addEventListener("click", handleSend);

    // Wire up input
    var input = document.getElementById("ms-widget-input");
    if (input) {
      input.addEventListener("keydown", handleKeydown);
      input.addEventListener("input", handleInput);
    }

    // Global keyboard handler
    document.addEventListener("keydown", handleDocumentKeydown);
  }

  // Run after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
