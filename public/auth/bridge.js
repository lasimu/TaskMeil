msalRedirectBridge.broadcastResponseToMainFrame().catch(function (err) {
  console.error("Sign-in answer could not be passed to the app", err);
  document.body.textContent = "Sisselogimine ebaõnnestus. Sulge see aken ja proovi uuesti.";
});
