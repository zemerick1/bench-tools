/**
 * Client auth cartoon: who talks to whom, who trusts the cert.
 * Device never talks to the NAC. RADIUS is the right-hand protocol. Grouped hops, not a pcap.
 */

export const DEFAULTS = {
  method: "open",
  medium: "ap",
  serverCert: "trusted",
  clientCert: "none",
  inner: "mschapv2",
  passwordOk: true,
  ocsp: "skip",
};

export const STORIES = [
  { id: "open", label: "Open", method: "open", clientCert: "none" },
  { id: "mac", label: "MAC auth", method: "mac", clientCert: "none" },
  { id: "portal", label: "Captive portal", method: "portal", clientCert: "none" },
  { id: "peap", label: "PEAP", method: "peap", clientCert: "none" },
  { id: "teap", label: "TEAP", method: "teap", inner: "mschapv2", clientCert: "none" },
  { id: "eap-tls", label: "EAP-TLS", method: "eap-tls", clientCert: "trusted" },
];

/** Flight + a beat to read the chip. 4× from Client Roam is too fast for packets. */
const HOP_SEC = 1.45;

const METHOD = {
  "eap-tls": "EAP-TLS",
  peap: "PEAP",
  "eap-ttls": "EAP-TTLS",
  teap: "TEAP",
};

const INNER = { mschapv2: "MSCHAPv2", pap: "PAP", tls: "TLS" };

function talk(what, eye, body) {
  return { what, caption: { eye, head: what, body }, tip: what };
}

function nasOf(cfg) {
  return cfg.medium === "switch" ? "switch" : "AP";
}

function usesClientCert(cfg) {
  return cfg.method === "eap-tls" || ((cfg.method === "peap" || cfg.method === "eap-ttls" || cfg.method === "teap") && cfg.inner === "tls");
}

function usesTunnel(cfg) {
  return cfg.method === "peap" || cfg.method === "eap-ttls" || cfg.method === "teap";
}

function usesTls(cfg) {
  return cfg.method === "eap-tls" || usesTunnel(cfg);
}

function certOf(status, ocsp) {
  if (!status || status === "none") return null;
  const signer = status === "unknown" ? "Unknown CA" : "Corp Root CA";
  const expiry = status === "expired" ? "expired 2019" : status === "name" ? "wrong name" : "Nov 2028";
  const ocspOut = status === "revoked" ? "revoked" : ocsp;
  const ok = status === "trusted" && ocspOut !== "revoked" && ocspOut !== "unreachable";
  return { signer, expiry, ocsp: ocspOut, ok };
}

function serverProblem(cfg) {
  const s = cfg.serverCert;
  if (s === "unknown") return "unknown CA";
  if (s === "expired") return "expired server cert";
  if (s === "name") return "wrong name";
  if (s === "revoked" && cfg.ocsp === "skip") return "revoked server cert";
  return null;
}

function ocspProblem(cfg) {
  if (cfg.ocsp === "skip") return null;
  if (cfg.ocsp === "revoked" || cfg.serverCert === "revoked") return "OCSP revoked";
  if (cfg.ocsp === "unreachable") return "OCSP unreachable";
  return null;
}

function clientProblem(cfg) {
  const c = cfg.clientCert;
  if (c === "none") return "no client cert";
  if (c === "unknown") return "unknown client CA";
  if (c === "expired") return "expired client cert";
  if (c === "revoked") return "revoked client cert";
  return null;
}

function rejectTalk(why, nas) {
  if (why === "unknown CA") {
    return talk(
      "The device does not trust who signed the server cert. It stops. No password, no client cert.",
      "Device folded",
      "Unknown signer is the end, not a warning. Fail closed.",
    );
  }
  if (why === "expired server cert") {
    return talk(
      "The device checked the dates. The server cert is expired, so it hangs up.",
      "Device folded",
      "The NAC can wait. The device already left.",
    );
  }
  if (why === "wrong name") {
    return talk(
      "The device looks at the name on the server cert. It does not match. Stop.",
      "Device folded",
      "A trusted CA signed the wrong box.",
    );
  }
  if (why === "revoked server cert" || why === "OCSP revoked") {
    return talk(
      "This is where we check if the server cert was revoked. It was. The device stops.",
      "OCSP said no",
      "Somebody asked. The answer was no.",
    );
  }
  if (why === "OCSP unreachable") {
    return talk(
      "This is where we try to check revocation and nobody answers. Policy says no.",
      "OCSP silent",
      "Skip means nobody asked. Unreachable means you asked and got fog.",
    );
  }
  if (why === "expired client cert") {
    return talk(
      "The NAC looked at the device cert. Expired. Access-Reject.",
      "NAC → " + nas,
      "The device trusted the server. The server did not trust the device. Mutual means both.",
    );
  }
  if (why === "unknown client CA" || why === "revoked client cert" || why === "no client cert") {
    return talk(
      "The NAC does not trust the device cert. Access-Reject.",
      "NAC → " + nas,
      "The " + nas + " just forwards the no.",
    );
  }
  if (why === "bad password") {
    return talk(
      "The password was wrong. The NAC says no. The " + nas + " never saw the password.",
      "NAC → " + nas,
      "Tunnel was fine. Password was not. That is later than people expect.",
    );
  }
  return talk("Fail closed. The cartoon stops.", "Reject", "Access-Reject. That is the whole review.");
}

export function simulate(settings = {}) {
  const cfg = { ...DEFAULTS, ...settings };
  const nas = nasOf(cfg);
  const hops = [];
  let t = 0;
  let n = 0;
  let outcome = "accept";
  let reason = "Access-Accept";
  let deviceTrustsServer = null;
  let serverTrustsDevice = null;

  let inTunnel = false;

  function add(from, to, wire, kind, label, bit) {
    n += 1;
    const dur = HOP_SEC;
    hops.push({
      t, dur, from, to, wire, kind, label,
      what: bit.what, caption: bit.caption, tip: bit.tip,
      inTunnel,
    });
    t += dur;
  }

  function fail(why, from, to, wire) {
    outcome = "reject";
    reason = why;
    const radius = wire === "radius";
    add(from, to, wire, "reject", radius ? "Access-Reject" : "EAP-Failure", rejectTalk(why, nas));
  }

  function finishOk() {
    add("radius", "authenticator", "radius", "accept", "Access-Accept", talk(
      "The NAC says yes. The " + nas + " may let the device on. The device still has not spoken RADIUS.",
      "NAC → " + nas,
      "Access-Accept is on the right wire. Always.",
    ));
    if (cfg.method !== "mac" && cfg.method !== "portal") {
      add("authenticator", "device", "eap", "success", "EAP-Success", talk(
        "The " + nas + " tells the device it worked. Still not talking to the NAC.",
        nas + " → device",
        "Success is EAP. The four-way is a different cartoon.",
      ));
      if (cfg.medium === "ap") {
        add("authenticator", "device", "assoc", "key", "4-way", talk(
          "This is the 4-way handshake. Device and AP start encrypting. One beat, not four messages.",
          "Device ↔ " + nas,
          "PMK from 802.1X, then keys. The NAC is already done.",
        ));
      }
    }
  }

  if (cfg.method === "open") {
    add("device", "authenticator", "assoc", "assoc", "open", talk(
      "Open network. Anyone who can hear it is on. There is no login.",
      "Device meets the " + nas,
      "No EAP, no RADIUS, no NAC. The door is not a door.",
    ));
  } else if (cfg.method === "mac") {
    add("device", "authenticator", "assoc", "assoc", "link up", talk(
      "The device shows up. It will not log in. The " + nas + " already has a MAC.",
      "Device shows up",
      "No identity, no EAP, no password. Nobody spoke. That is the method.",
    ));
    add("authenticator", "radius", "radius", "mac", "Access-Request", talk(
      "The " + nas + " sends the MAC address to the NAC and calls it a username. The device sent nothing.",
      nas + " → NAC",
      "MAB is not 802.1X. Zero EAP hops.",
    ));
    if (cfg.passwordOk === false) fail("bad password", "radius", "authenticator", "radius");
    else finishOk();
  } else if (cfg.method === "portal") {
    add("device", "portal", "https", "portal-https", "HTTPS", talk(
      "The device opens a web page. That page is not the NAC.",
      "Device → portal",
      "Already on the network. Still no NAC IP on the device.",
    ));
    add("portal", "device", "https", "portal-https", "login", talk(
      "The website shows a login form.",
      "Portal → device",
      "The " + nas + " has not called the NAC yet.",
    ));
    add("device", "portal", "https", "portal-https", "submit", talk(
      "This is where the person types a username and password — into the website, not to the NAC.",
      "Device → portal",
      "The portal will nag the " + nas + ". The " + nas + " still owns the right wire.",
    ));
    add("authenticator", "radius", "radius", "identity", "Access-Request", talk(
      "Now the " + nas + " sends that name to the NAC over RADIUS. The device never got the NAC IP.",
      nas + " → NAC",
      "Captive portal. The device still did not speak RADIUS.",
    ));
    if (cfg.passwordOk === false) fail("bad password", "radius", "authenticator", "radius");
    else {
      finishOk();
      add("portal", "device", "https", "portal-https", "in", talk(
        "The website says you’re in. The NAC already said yes on the other wire.",
        "Portal → device",
        "The portal is just the sign on the door.",
      ));
    }
  } else {
    add("device", "authenticator", "assoc", "assoc", cfg.medium === "switch" ? "link up" : "assoc", talk(
      "The device joins the " + nas + ". Nobody has a username yet.",
      "Device meets the " + nas,
      "Association is plumbing. That is not a login.",
    ));
    add("authenticator", "device", "eap", "identity", "EAP-Request", talk(
      "The " + nas + " asks the device for a name.",
      nas + " → device",
      "This is EAP-Request on the left wire — not Access-Request.",
    ));
    add("device", "authenticator", "eap", "identity", "EAP-Response", talk(
      usesTunnel(cfg)
        ? "The device sends an outer name — often “anonymous,” not the real username yet."
        : "The device sends its username (or the name on the cert) to the " + nas + ".",
      "Device → " + nas,
      usesTunnel(cfg)
        ? "PEAP/TTLS hide the real username inside the tunnel, next. The NAC has not heard a thing yet."
        : "That name is EAP, on the left wire. The NAC has not heard a thing yet.",
    ));
    add("authenticator", "radius", "radius", "identity", "Access-Request", talk(
      "The " + nas + " forwards that name to the NAC over RADIUS. The device still has not spoken RADIUS.",
      nas + " → NAC",
      "Access-Request never goes to the device. The NAD is the RADIUS client.",
    ));
    add("radius", "authenticator", "radius", "method", "Access-Challenge", talk(
      "The NAC picks the login method (" + (METHOD[cfg.method] || cfg.method) + "). The " + nas + " did not choose it.",
      "NAC → " + nas,
      "The " + nas + " will copy this onto the air as EAP-Request. The device has not seen the NAC.",
    ));
    add("authenticator", "device", "eap", "method", "EAP-Request", talk(
      "The " + nas + " tells the device: use " + (METHOD[cfg.method] || cfg.method) + ".",
      nas + " → device",
      "NAD → device is EAP-Request. Access-Request already happened on the other wire.",
    ));

    if (usesTls(cfg)) {
      add("device", "authenticator", "eap", "tls-hello", "ClientHello", talk(
        "The device starts a TLS tunnel. The " + nas + " cannot read it.",
        "Device → " + nas,
        "The tunnel is device to the NAC. The " + nas + " is a tube.",
      ));
      add("authenticator", "radius", "radius", "tls-hello", "Access-Request", talk(
        "The " + nas + " forwards that TLS hello to the NAC.",
        nas + " → NAC",
        "Same bytes, new envelope. That is the whole job of the " + nas + ".",
      ));
      add("radius", "authenticator", "radius", "tls-server-cert", "Access-Challenge", talk(
        "The NAC sends its server certificate to the " + nas + ".",
        "NAC → " + nas,
        "Who talks to whom: the NAC to the authenticator, not to the device.",
      ));
      add("authenticator", "device", "eap", "tls-server-cert", "server cert", talk(
        "This is where the device verifies the server cert — who signed it, dates, name.",
        nas + " → device",
        "If the CA is missing, this is the end. Do not send a password to a stranger.",
      ));

      const sFail = serverProblem(cfg);
      if (sFail) {
        deviceTrustsServer = false;
        fail(sFail, "device", "authenticator", "eap");
      } else {
        if (cfg.ocsp !== "skip") {
          add("authenticator", "device", "eap", "ocsp", "OCSP", talk(
            cfg.ocsp === "good" && cfg.serverCert !== "revoked"
              ? "This is where we check if the server cert was revoked. It is still good."
              : "This is where we check if the server cert was revoked.",
            "OCSP",
            "Skip means nobody asked. Revoked means somebody did, and the answer was no.",
          ));
        }
        const oFail = ocspProblem(cfg);
        if (oFail) {
          deviceTrustsServer = false;
          fail(oFail, "device", "authenticator", "eap");
        } else {
          deviceTrustsServer = true;
        }
      }

      if (outcome === "accept" && usesTunnel(cfg)) {
        add("device", "authenticator", "eap", "tunnel", "Tunnel up", talk(
          "The TLS tunnel is up. What follows rides inside it — the AP still cannot read it.",
          "Tunnel established",
          "This is the gold pipe on the PEAP diagram. Inner username and password live in here.",
        ));
        inTunnel = true;
      }

      if (outcome === "accept" && usesClientCert(cfg)) {
        add("device", "authenticator", "eap", "tls-client-cert", "client cert", talk(
          "This is where the device sends its own certificate.",
          "Device → " + nas,
          "EAP-TLS is mutual. The " + nas + " still cannot read it.",
        ));
        add("authenticator", "radius", "radius", "tls-client-cert", "Access-Request", talk(
          "The " + nas + " forwards the device cert to the NAC. The NAC decides if it trusts it.",
          nas + " → NAC",
          "Who trusts the cert: the server, looking at the device.",
        ));
        const cFail = clientProblem(cfg);
        if (cFail) {
          serverTrustsDevice = false;
          fail(cFail, "radius", "authenticator", "radius");
        } else {
          serverTrustsDevice = true;
        }
      } else if (outcome === "accept" && usesTunnel(cfg)) {
        add("device", "authenticator", "eap", "inner", "inner id", talk(
          cfg.inner === "tls"
            ? "Inside the tunnel, the device sends a second identity for the inner login."
            : "This is where the real username is sent — inside the tunnel, not in that first EAP-Response.",
          "Inside the tunnel",
          "The " + nas + " is illiterate here. The NAC, at the far end of TLS, can read it.",
        ));
        add("authenticator", "radius", "radius", "inner", "Access-Request", talk(
          "The " + nas + " forwards that encrypted username to the NAC. It cannot read it.",
          nas + " → NAC",
          "Ciphertext in, ciphertext out. The " + nas + " does not get a name.",
        ));
        add("radius", "authenticator", "radius", "inner", "Access-Challenge", talk(
          "The NAC asks the device to prove the password (" + (INNER[cfg.inner] || "inner") + ").",
          "NAC → " + nas,
          "Challenge is not Accept. People mix those up.",
        ));
        add("device", "authenticator", "eap", "inner", "password", talk(
          cfg.inner === "tls"
            ? "This is where the inner client cert (or inner TLS) is sent, still inside the tunnel."
            : "This is where the password proof is sent — inside the tunnel. The " + nas + " never sees the password.",
          "Password proof",
          "If you did not trust the server cert, you should not be here.",
        ));
        add("authenticator", "radius", "radius", "inner", "Access-Request", talk(
          "The " + nas + " forwards the password proof to the NAC. The device never sent RADIUS.",
          nas + " → NAC",
          "Left wire EAP. Right wire Access-Request. Same secret, different envelope.",
        ));
        if (cfg.passwordOk === false) fail("bad password", "radius", "authenticator", "radius");
        inTunnel = false;
      }

      if (outcome === "accept") finishOk();
    }
  }

  const last = hops[hops.length - 1];
  const noCerts = cfg.method === "mac" || cfg.method === "portal" || cfg.method === "open";
  const serverCert = noCerts ? null : certOf(cfg.serverCert, cfg.ocsp);
  const clientCert = noCerts || !usesClientCert(cfg) || cfg.clientCert === "none"
    ? null
    : certOf(cfg.clientCert, cfg.clientCert === "revoked" ? "revoked" : "skip");

  return {
    hops,
    duration: last ? last.t + last.dur : 0,
    outcome,
    reason,
    trust: { deviceTrustsServer, serverTrustsDevice },
    certs: { server: serverCert, client: clientCert },
  };
}

export function hopAt(run, t) {
  const hops = run?.hops || [];
  let found = null;
  for (const h of hops) {
    if (h.t <= t && t <= h.t + h.dur) found = h;
  }
  return found;
}

export function hopsHappened(run, t) {
  return (run?.hops || []).filter((h) => h.t <= t);
}
