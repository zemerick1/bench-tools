/**
 * Subnet Planner — greenfield IPv4 scheme designer (not a toy calculator).
 *
 * Fundamentals (human numbering, not computer 0-based slots):
 * - Site as **second number**: 10.<site>.…  (site 1 → 10.1.x.x)
 * - Site as **third number**:  10.<vlan>.<site>.…  (site 1, VLAN 20 → 10.20.1.x)
 * - Gateway always network+1 (classic .1 when the block starts on .0)
 * - ≥50% headroom; min size /25; third-number mode only allows /24–/25 so the
 *   site number stays literally the third dotted number (no 10.20.32.0 for “site 1”)
 */

export const HEADROOM = 1.5;
export const AUTO_VLAN_START = 10;
export const AUTO_VLAN_STEP = 10;
/** Smallest block we assign. /26–/30 are too fiddly for this planner. */
export const MIN_PREFIX = 25;
/**
 * When site is the third number, each site owns one third-number cell (/24).
 * Live may be /25 or /24 only — never /23 or wider (that rewrites the third number).
 */
export const THIRD_NUMBER_MAX_PREFIX = 24; // largest block = /24 (prefix number 24)

/** @typedef {'connected' | 'isolated'} ConnectionModel */
/** @typedef {'10.0.0.0/8' | '172.16.0.0/12' | '192.168.0.0/16'} PrivateSpace */
/**
 * Where the site number appears in 10.a.b.c:
 * - second → a = site   (10.<site>.…)
 * - third  → b = site   (10.<vlan>.<site>.…)
 *
 * Legacy aliases still accepted: before-vlan → second, after-vlan → third.
 */
/** @typedef {'second' | 'third'} SitePosition */

/**
 * @typedef {object} BuildingInput
 * @property {string} name
 * @property {number | null} [index]
 */

/**
 * @typedef {object} RoleInput
 * @property {string} name
 * @property {number} devicesPerBuilding
 * @property {number | null} [vlanId]
 * @property {number | null} [prefixOverride]
 */

/**
 * @typedef {object} PlanInput
 * @property {BuildingInput[]} buildings
 * @property {RoleInput[]} roles
 * @property {ConnectionModel} connectionModel
 * @property {PrivateSpace} privateSpace
 * @property {SitePosition | 'before-vlan' | 'after-vlan'} [sitePosition]
 */

/**
 * @typedef {object} PlanRow
 * @property {string} building
 * @property {number} buildingIndex
 * @property {string} role
 * @property {number} vlanId
 * @property {number} devicesSaid
 * @property {number} sizedFor
 * @property {number} suggestedPrefix
 * @property {number} usedPrefix
 * @property {number} reservedPrefix
 * @property {string} subnet
 * @property {string} gateway
 * @property {number} usable
 * @property {string} reservedLane
 * @property {string} reservedEnd
 * @property {string} reservedRange
 * @property {string} roleParent
 * @property {string} sizeNote
 * @property {string[]} notices
 * @property {SitePosition} sitePosition
 */

/**
 * @typedef {object} PlanResult
 * @property {boolean} ok
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {PlanRow[]} rows
 * @property {string} sticky
 * @property {object} [meta]
 */

// —— IPv4 / CIDR helpers ————————————————————————————————————————————————

/** @param {string} ip */
export function ipToInt(ip) {
  const parts = String(ip).trim().split(".");
  if (parts.length !== 4) throw new Error(`Bad IPv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) throw new Error(`Bad IPv4: ${ip}`);
    n = ((n << 8) >>> 0) + o;
  }
  return n >>> 0;
}

/** @param {number} n */
export function intToIp(n) {
  const x = n >>> 0;
  return [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".");
}

/** @param {string} cidr */
export function parseCidr(cidr) {
  const m = String(cidr).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) throw new Error(`Bad CIDR: ${cidr}`);
  const prefix = Number(m[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Bad prefix: ${cidr}`);
  }
  const base = ipToInt(m[1]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (base & mask) >>> 0;
  const size = prefix === 32 ? 1 : 2 ** (32 - prefix);
  const broadcast = (network + size - 1) >>> 0;
  return { network, broadcast, prefix, size, mask, cidr: `${intToIp(network)}/${prefix}` };
}

export function usableHosts(prefix) {
  if (prefix >= 31) return prefix === 31 ? 2 : 1;
  if (prefix <= 0) return 0;
  return 2 ** (32 - prefix) - 2;
}

/** Never tighter than MIN_PREFIX (/25). */
export function prefixForUsable(need) {
  const n = Math.max(1, Math.ceil(need));
  for (let p = MIN_PREFIX; p >= 8; p--) {
    if (usableHosts(p) >= n) return p;
  }
  if (usableHosts(8) >= n) return 8;
  return null;
}

export function sizedFor(devices) {
  return Math.ceil(Number(devices) * HEADROOM);
}

export function suggestPrefix(devices) {
  return prefixForUsable(sizedFor(devices));
}

/**
 * @param {{network:number,broadcast:number}} a
 * @param {{network:number,broadcast:number}} b
 */
export function rangesOverlap(a, b) {
  return a.network <= b.broadcast && b.network <= a.broadcast;
}

export function nextPow2(n) {
  let x = Math.max(1, Math.ceil(n));
  let p = 1;
  while (p < x) p <<= 1;
  return p;
}

/** @param {number} addr @param {number} alignSize */
export function alignUp(addr, alignSize) {
  if (alignSize <= 1) return addr >>> 0;
  const a = alignSize >>> 0;
  return ((addr + a - 1) & ~(a - 1)) >>> 0;
}

/** Normalize UI / legacy values to second | third. */
export function normalizeSitePosition(raw) {
  if (raw === "second" || raw === "before-vlan") return "second";
  if (raw === "third" || raw === "after-vlan") return "third";
  return "second"; // default: 10.<site>.…
}

/**
 * Reserved lane width for growth.
 * - third-number mode: always the /24 cell around 10.v.s.x
 * - second-number mode: one-bit wider than live for modest subnets only.
 *   Do NOT double /17→/16 (that eats the entire 10.<site>.0.0/16 and makes every
 *   other role fail with a misleading “not enough room” error).
 *
 * @param {number} usedPrefix
 * @param {SitePosition} sitePosition
 */
export function reservedPrefixFor(usedPrefix, sitePosition) {
  if (sitePosition === "third") return 24;
  const used = Number(usedPrefix);
  // usedPrefix <= 17 means live is /17 or larger block; doubling would be >= /16
  if (used <= 17) return used;
  return Math.max(8, used - 1);
}

/** Addresses in a prefix length (including network/broadcast). */
export function prefixSize(prefix) {
  if (prefix >= 32) return 1;
  if (prefix <= 0) return 2 ** 32;
  return 2 ** (32 - prefix);
}

const SPACES = {
  "10.0.0.0/8": parseCidr("10.0.0.0/8"),
  "172.16.0.0/12": parseCidr("172.16.0.0/12"),
  "192.168.0.0/16": parseCidr("192.168.0.0/16"),
};

/** @param {PrivateSpace} key */
export function privateSpaceBlock(key) {
  const b = SPACES[key];
  if (!b) throw new Error(`Unknown private space: ${key}`);
  return b;
}

// —— Plan ————————————————————————————————————————————————————————————————

/**
 * @param {PlanInput} input
 * @returns {PlanResult}
 */
export function buildPlan(input) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const buildingsIn = Array.isArray(input.buildings) ? input.buildings : [];
  const rolesIn = Array.isArray(input.roles) ? input.roles : [];
  const connectionModel = input.connectionModel === "isolated" ? "isolated" : "connected";
  const spaceKey = input.privateSpace || "10.0.0.0/8";
  const sitePosition = normalizeSitePosition(input.sitePosition);

  let space;
  try {
    space = privateSpaceBlock(/** @type {PrivateSpace} */ (spaceKey));
  } catch (e) {
    return fail([String(/** @type {Error} */ (e).message || e)]);
  }

  if (!buildingsIn.length) {
    errors.push("Add at least one building. Floors and broom closets are out of scope — buildings only.");
  }
  if (!rolesIn.length) {
    errors.push("Add at least one role (Students, IoT, Infrastructure…). A blank plan is just a blank stare.");
  }

  // —— Buildings (human site numbers 1–254) ——————————————————————————————
  /** @type {{name:string, index:number}[]} */
  const buildings = [];
  const usedIndexes = new Set();
  let autoIdx = 1;

  for (let i = 0; i < buildingsIn.length; i++) {
    const raw = buildingsIn[i];
    const name = String(raw?.name || "").trim();
    if (!name) {
      errors.push(`Building #${i + 1}: name is required.`);
      continue;
    }
    let index =
      raw.index === null || raw.index === undefined || raw.index === ""
        ? null
        : Number(raw.index);
    if (index === null) {
      while (usedIndexes.has(autoIdx)) autoIdx++;
      index = autoIdx++;
    } else {
      if (!Number.isInteger(index) || index < 1 || index > 254) {
        errors.push(
          `Building “${name}”: site number must be an integer 1–254 (it becomes part of the address).`
        );
        continue;
      }
    }
    if (usedIndexes.has(index)) {
      errors.push(`Building “${name}”: site number ${index} is already used.`);
      continue;
    }
    usedIndexes.add(index);
    buildings.push({ name, index });
  }
  buildings.sort((a, b) => a.index - b.index);

  // —— Roles ————————————————————————————————————————————————————————————
  /** @type {{name:string, devices:number, vlanId:number|null, prefixOverride:number|null, suggestedPrefix:number, usedPrefix:number, reservedPrefix:number, sizedFor:number}[]} */
  const roles = [];
  const nameSeen = new Set();
  /** @type {Map<number, string>} */
  const vlanOwner = new Map();
  let nextAutoVlan = AUTO_VLAN_START;

  for (let i = 0; i < rolesIn.length; i++) {
    const raw = rolesIn[i];
    const name = String(raw?.name || "").trim();
    if (!name) {
      errors.push(`Role #${i + 1}: give it a name (Students, IoT, Infrastructure…).`);
      continue;
    }
    const nameKey = name.toLowerCase();
    if (nameSeen.has(nameKey)) {
      errors.push(`Role “${name}” appears twice. One purpose per row.`);
      continue;
    }
    nameSeen.add(nameKey);

    const devices = Number(raw.devicesPerBuilding);
    if (!Number.isInteger(devices) || devices < 1 || devices > 1_000_000) {
      errors.push(`Role “${name}”: devices per building must be an integer from 1 to 1,000,000.`);
      continue;
    }

    const need = sizedFor(devices);
    const suggested = suggestPrefix(devices);
    if (suggested == null) {
      errors.push(`Role “${name}”: ${devices} devices (+50% → ${need}) will not fit in IPv4 sensibly.`);
      continue;
    }

    let prefixOverride = null;
    if (raw.prefixOverride !== null && raw.prefixOverride !== undefined && raw.prefixOverride !== "") {
      prefixOverride = Number(raw.prefixOverride);
      if (!Number.isInteger(prefixOverride) || prefixOverride < 8 || prefixOverride > MIN_PREFIX) {
        errors.push(
          `Role “${name}”: prefix override must be /8–/${MIN_PREFIX} if set. We do not use tighter than /${MIN_PREFIX}.`
        );
        continue;
      }
      if (prefixOverride > suggested) {
        errors.push(
          `Role “${name}”: /${prefixOverride} is too small for ~${need} addresses (need at least /${suggested}).`
        );
        continue;
      }
    }

    let usedPrefix = prefixOverride != null ? prefixOverride : suggested;

    // Third-number mode: site is the third dotted number → only /24 or /25 fit in 10.v.s.x
    if (sitePosition === "third" && usedPrefix < THIRD_NUMBER_MAX_PREFIX) {
      errors.push(
        `Role “${name}” needs /${usedPrefix} (~${usableHosts(usedPrefix)} usable after sizing), but ` +
          `with site as the **third number** each site only gets a 10.<vlan>.<site>.x cell (/24 max). ` +
          `Use site as the **second number** (10.<site>.…), lower the device count, or split the role.`
      );
      continue;
    }

    const reservedPrefix = reservedPrefixFor(usedPrefix, sitePosition);

    let vlanId =
      raw.vlanId === null || raw.vlanId === undefined || raw.vlanId === ""
        ? null
        : Number(raw.vlanId);

    if (vlanId !== null) {
      if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
        errors.push(`Role “${name}”: VLAN ID must be 1–4094 if you set one.`);
        continue;
      }
      if (vlanId === 1) {
        errors.push(`Role “${name}”: VLAN 1 is not a greenfield design choice. Pick another or leave blank.`);
        continue;
      }
      if (vlanId > 254) {
        errors.push(
          `Role “${name}”: VLAN ${vlanId} cannot be used as an address number (need 2–254). Leave blank for auto or pick ≤254.`
        );
        continue;
      }
      if (vlanOwner.has(vlanId)) {
        errors.push(
          `VLAN ${vlanId} is claimed by “${vlanOwner.get(vlanId)}” and “${name}”. One VLAN per role row.`
        );
        continue;
      }
      vlanOwner.set(vlanId, name);
    }

    roles.push({
      name,
      devices,
      vlanId,
      prefixOverride,
      suggestedPrefix: suggested,
      usedPrefix,
      reservedPrefix,
      sizedFor: need,
    });
  }

  for (const role of roles) {
    if (role.vlanId != null) continue;
    while (vlanOwner.has(nextAutoVlan) || nextAutoVlan === 1) {
      nextAutoVlan += AUTO_VLAN_STEP;
      if (nextAutoVlan > 254) {
        errors.push(`Ran out of auto VLAN IDs under 254 while placing “${role.name}”.`);
        break;
      }
    }
    if (nextAutoVlan > 254) break;
    role.vlanId = nextAutoVlan;
    vlanOwner.set(nextAutoVlan, role.name);
    nextAutoVlan += AUTO_VLAN_STEP;
  }

  const hasInfra = roles.some((r) => /infra|switch|access.?point|\bap\b|management/i.test(r.name));
  if (roles.length && !hasInfra) {
    warnings.push(
      "No Infrastructure-ish role spotted. Switches and APs deserve their own VLAN."
    );
  }

  if (errors.length) return fail(errors, warnings);

  const rolesSorted = [...roles].sort((a, b) => (a.vlanId || 0) - (b.vlanId || 0));
  const maxSiteIndex = Math.max(...buildings.map((b) => b.index));

  /** @type {PlanRow[]} */
  const rows = [];
  /** @type {{network:number,broadcast:number}[]} */
  const claimed = [];

  /**
   * @param {number} network
   * @param {number} size
   * @param {string} label
   */
  function claim(network, size, label) {
    const broadcast = (network + size - 1) >>> 0;
    if (network < space.network || broadcast > space.broadcast) {
      errors.push(`“${label}” falls outside ${spaceKey}.`);
      return false;
    }
    const range = { network, broadcast };
    for (const c of claimed) {
      if (rangesOverlap(range, c)) {
        errors.push(`Overlap placing “${label}” (${intToIp(network)} size ${size}).`);
        return false;
      }
    }
    claimed.push(range);
    return true;
  }

  /**
   * @param {object} p
   * @param {typeof rolesSorted[0]} p.role
   * @param {{name:string,index:number}} p.building
   * @param {number} p.liveNet
   * @param {number} p.usedP
   * @param {number} p.laneNet
   * @param {number} p.lanePrefix
   * @param {string} p.parentCidr
   * @param {string[]} p.notices
   */
  function emitRow(p) {
    const { role, building: b, liveNet, usedP, laneNet, lanePrefix, parentCidr, notices } = p;
    const liveSize = 2 ** (32 - usedP);
    if ((liveNet & (liveSize - 1)) !== 0) {
      errors.push(`Alignment failure: ${role.name} @ ${b.name} ${intToIp(liveNet)}/${usedP}`);
      return;
    }
    const laneSize = 2 ** (32 - lanePrefix);
    if (!claim(laneNet, laneSize, `${role.name}@${b.name} lane`)) return;

    const usable = usableHosts(usedP);
    const oversize = usedP < role.suggestedPrefix;
    const subnet = `${intToIp(liveNet)}/${usedP}`;
    const gateway = intToIp((liveNet + 1) >>> 0);
    const reservedLane = `${intToIp(laneNet)}/${lanePrefix}`;
    const reservedEnd = intToIp((laneNet + laneSize - 1) >>> 0);
    const reservedRange = `${intToIp(laneNet)} – ${reservedEnd}`;

    /** @type {string[]} */
    const noteList = [...notices];
    if (oversize) {
      noteList.push(`Oversized to /${usedP} (math suggested /${role.suggestedPrefix}).`);
    }
    noteList.push(`Reservation ends at ${reservedEnd}. Grow only inside this range.`);

    let sizeNote = `${role.devices} said → ${role.sizedFor} with 50% headroom → /${role.suggestedPrefix} math`;
    sizeNote += `; using /${usedP} (${usable} usable)`;
    if (usedP === MIN_PREFIX && role.sizedFor < usableHosts(MIN_PREFIX)) {
      sizeNote += ` (floor /${MIN_PREFIX})`;
    }

    rows.push({
      building: b.name,
      buildingIndex: b.index,
      role: role.name,
      vlanId: /** @type {number} */ (role.vlanId),
      devicesSaid: role.devices,
      sizedFor: role.sizedFor,
      suggestedPrefix: role.suggestedPrefix,
      usedPrefix: usedP,
      reservedPrefix: lanePrefix,
      subnet,
      gateway,
      usable,
      reservedLane,
      reservedEnd,
      reservedRange,
      roleParent: parentCidr,
      sizeNote,
      notices: noteList,
      sitePosition,
    });
  }

  // —— Placement ————————————————————————————————————————————————————————

  if (sitePosition === "third") {
    // Literal: 10.<vlan>.<site>.0/P  with P in {24,25}. Site number IS the third number.
    warnings.unshift(
      "Site is the third number in the IP (e.g. 10.20.1.x for VLAN 20, site 1). " +
        "Each site/role uses one third-number cell (/24). Larger than /24 is not allowed in this mode."
    );

    for (const role of rolesSorted) {
      const vlan = /** @type {number} */ (role.vlanId);
      const usedP = role.usedPrefix;
      const parentCidr =
        spaceKey === "10.0.0.0/8" ? `10.${vlan}.0.0/16` : `${intToIp(space.network)}/${space.prefix}`;

      for (const b of buildings) {
        if (spaceKey !== "10.0.0.0/8") {
          errors.push("Site as third number currently requires 10.0.0.0/8 private space.");
          break;
        }
        const liveNet = ipToInt(`10.${vlan}.${b.index}.0`);
        const laneNet = liveNet; // whole 10.v.s.0/24 cell
        emitRow({
          role,
          building: b,
          liveNet,
          usedP,
          laneNet,
          lanePrefix: 24,
          parentCidr,
          notices: [
            `Site ${b.index} is the third number: ${intToIp(liveNet).replace(/\.0$/, ".x")} (human site ${b.index}, not zero-based).`,
          ],
        });
      }
    }
  } else {
    // Site as second number: 10.<site>.…  Pack roles under each site from .0 upward (no empty “slot 0” tax).
    // Hard ceiling per site is 10.<site>.0.0/16 (65,536 addresses) — that is what “second number = site”
    // means. 10.0.0.0/8 has plenty of space overall; each site still only owns one second number.
    warnings.unshift(
      "Site is the second number in the IP (e.g. 10.1.x.x for site 1). Each site owns 10.<site>.0.0/16; roles pack under that block."
    );

    for (const b of buildings) {
      if (spaceKey !== "10.0.0.0/8") {
        errors.push("Site as second number currently requires 10.0.0.0/8 private space.");
        break;
      }
      const siteBase = ipToInt(`10.${b.index}.0.0`);
      const siteParentSize = prefixSize(16); // /16 per site under 10/8
      const parentCidr = `10.${b.index}.0.0/16`;

      const packOrder = [...rolesSorted].sort(
        (a, c) => a.usedPrefix - c.usedPrefix || (a.vlanId || 0) - (c.vlanId || 0)
      );

      // Preflight: sum reserved lanes (with alignment slack upper bound = sum of sizes)
      let reservedNeed = 0;
      for (const role of packOrder) {
        reservedNeed += prefixSize(role.reservedPrefix);
      }
      if (reservedNeed > siteParentSize) {
        errors.push(
          `Site ${b.index} (${b.name}): roles need about ${reservedNeed.toLocaleString()} addresses of reserved space, ` +
            `but site-as-second-number only gives ${parentCidr} (${siteParentSize.toLocaleString()} addresses). ` +
            `That is not “10.0.0.0/8 is full” — only this site’s second number (10.${b.index}.x.x) is full. ` +
            `Shrink or split large roles (e.g. mega-ultra), or use fewer roles per building.`
        );
        continue;
      }

      let cursor = siteBase;
      const siteEnd = (siteBase + siteParentSize - 1) >>> 0;

      for (const role of packOrder) {
        const usedP = role.usedPrefix;
        const lanePrefix = role.reservedPrefix;
        const laneSize = prefixSize(lanePrefix);
        const liveSize = prefixSize(usedP);
        cursor = alignUp(cursor, laneSize);
        if (cursor + laneSize - 1 > siteEnd) {
          errors.push(
            `Site ${b.index} (${b.name}): could not pack “${role.name}” (live /${usedP}, reserved /${lanePrefix}) into ${parentCidr} ` +
              `after placing larger roles. Site-as-second-number is limited to 10.${b.index}.0.0/16 — ` +
              `not a shortage of the whole 10.0.0.0/8. Shrink a larger role or remove one.`
          );
          continue;
        }
        const laneNet = cursor;
        const liveNet = laneNet;
        if ((liveNet & (liveSize - 1)) !== 0) {
          errors.push(`Alignment failure packing ${role.name} @ site ${b.index}`);
          continue;
        }
        if (intToIp(liveNet).split(".")[1] !== String(b.index)) {
          errors.push(
            `Internal error: expected second number ${b.index}, got ${intToIp(liveNet)} for ${role.name}.`
          );
          continue;
        }
        emitRow({
          role,
          building: b,
          liveNet,
          usedP,
          laneNet,
          lanePrefix,
          parentCidr,
          notices: [
            `Site ${b.index} is the second number: addresses are 10.${b.index}.x.x under ${parentCidr}.`,
            lanePrefix < usedP
              ? `Reserved /${lanePrefix} (wider than live /${usedP}) for growth.`
              : `Reserved /${lanePrefix} matches live size (large block — no extra doubling that would fill the whole /16).`,
          ],
        });
        cursor = (laneNet + laneSize) >>> 0;
      }
    }
  }

  // Double-check live overlaps (lanes already claimed)
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = parseCidr(rows[i].subnet);
      const b = parseCidr(rows[j].subnet);
      if (rangesOverlap(a, b)) {
        if (connectionModel === "connected") {
          errors.push(
            `Overlap: ${rows[i].role} @ ${rows[i].building} (${rows[i].subnet}) vs ${rows[j].role} @ ${rows[j].building} (${rows[j].subnet}).`
          );
        } else {
          warnings.push(`Overlap under isolated mode: ${rows[i].subnet} appears more than once.`);
        }
      }
    }
  }

  if (connectionModel === "isolated") {
    warnings.push(
      "Buildings marked isolated: this greenfield plan still uses unique subnets so you are safer if you connect them later."
    );
  }

  warnings.unshift(
    "Plan for growth: ≥50% headroom on device counts. " +
      (sitePosition === "third"
        ? "Third-number mode: grow only inside the same 10.<vlan>.<site>.0–255 cell."
        : "Second-number mode: each role has a reserved lane under 10.<site>.0.0/16 so neighbors are not eaten.")
  );

  if (errors.length) return fail(errors, warnings);

  rows.sort((a, b) => a.buildingIndex - b.buildingIndex || a.vlanId - b.vlanId);

  const usedVlans = [...new Set(rolesSorted.map((r) => r.vlanId).filter(Boolean))].sort(
    (a, b) => /** @type {number} */ (a) - /** @type {number} */ (b)
  );
  let nextFreeAutoVlan = AUTO_VLAN_START;
  const usedSet = new Set(usedVlans);
  while (usedSet.has(nextFreeAutoVlan) || nextFreeAutoVlan === 1) {
    nextFreeAutoVlan += AUTO_VLAN_STEP;
    if (nextFreeAutoVlan > 254) break;
  }
  let freeSecondNumbers = 0;
  for (let o = 2; o <= 254; o++) {
    if (!usedSet.has(o) && !buildings.some((b) => b.index === o && sitePosition === "second")) {
      // for second-mode, site numbers also consume second number; count free for VLANs only roughly
    }
    if (!usedSet.has(o)) freeSecondNumbers++;
  }
  // Sites used as second number are not free for VLANs in third mode; in second mode sites own second numbers
  if (sitePosition === "second") {
    freeSecondNumbers = 0;
    for (let o = 2; o <= 254; o++) {
      if (!buildings.some((b) => b.index === o) && !usedSet.has(o)) freeSecondNumbers++;
    }
  }

  const capacity = {
    nextAutoVlan: nextFreeAutoVlan <= 254 ? nextFreeAutoVlan : null,
    freeSecondOctets: freeSecondNumbers,
    usedVlans,
    maxSiteInPlan: maxSiteIndex,
    maxSiteThatFits: sitePosition === "third" ? 254 : 254,
    spareSiteNumbers: Math.max(0, 254 - maxSiteIndex),
    sitePosition,
    noteRoles:
      nextFreeAutoVlan <= 254
        ? `Another role: next auto VLAN would be ${nextFreeAutoVlan}. Add the row and rebuild.`
        : `Another role: set VLAN IDs manually (auto sequence exhausted under 254).`,
    noteSites:
      sitePosition === "second"
        ? `Another building: pick a free site number 1–254 (becomes 10.<site>.…). Rebuild after adding.`
        : `Another building: pick site number 1–254 (becomes the third number: 10.<vlan>.<site>.…). Rebuild after adding.`,
    noteWithinRole:
      sitePosition === "third"
        ? "Within a site/role: stay inside Reservation ends (the same third-number /24 cell)."
        : "Within a site: grow only through Reservation ends so the next role under that site is not stomped.",
  };

  const sticky = buildSticky({
    spaceKey,
    connectionModel,
    sitePosition,
    buildings,
    roles: rolesSorted,
    rows,
    warnings,
    capacity,
  });

  return {
    ok: true,
    errors: [],
    warnings,
    rows,
    sticky,
    meta: {
      privateSpace: spaceKey,
      connectionModel,
      sitePosition,
      headroom: HEADROOM,
      buildingCount: buildings.length,
      roleCount: rolesSorted.length,
      capacity,
    },
  };
}

/** @param {string[]} errors @param {string[]} [warnings] */
function fail(errors, warnings = []) {
  return {
    ok: false,
    errors,
    warnings,
    rows: [],
    sticky: "",
  };
}

/**
 * @param {object} p
 * @param {string} p.spaceKey
 * @param {string} p.connectionModel
 * @param {SitePosition} [p.sitePosition]
 * @param {{name:string,index:number}[]} p.buildings
 * @param {{name:string,vlanId:number|null,devices:number,usedPrefix:number|null}[]} p.roles
 * @param {PlanRow[]} p.rows
 * @param {string[]} p.warnings
 * @param {object} [p.capacity]
 */
function buildSticky(p) {
  const lines = [];
  lines.push("SUBNET PLANNER — greenfield sticky");
  lines.push("─".repeat(52));
  lines.push(`Private space: ${p.spaceKey}`);
  lines.push(
    `Buildings talk to each other: ${p.connectionModel === "connected" ? "yes (unique subnets)" : "no / isolated"}`
  );
  lines.push(
    `Site number is the ${p.sitePosition === "second" ? "second" : "third"} number in the IP ` +
      `(${p.sitePosition === "second" ? "10.<site>.x.x" : "10.<vlan>.<site>.x"})`
  );
  lines.push(`Headroom: 50% minimum; min size /${MIN_PREFIX}; gateway = first usable (.1 on .0 blocks).`);
  lines.push("");
  lines.push("Buildings:");
  for (const b of p.buildings) {
    lines.push(`  • ${b.name} (site ${b.index})`);
  }
  lines.push("");
  lines.push("Roles:");
  for (const r of p.roles) {
    lines.push(`  • ${r.name} — VLAN ${r.vlanId}, ${r.devices}/building → /${r.usedPrefix}`);
  }
  lines.push("");
  lines.push("Assignments:");
  for (const row of p.rows) {
    lines.push(
      `  ${row.building} | ${row.role} | VLAN ${row.vlanId} | ${row.subnet} | gw ${row.gateway} | usable ${row.usable} | reserved through ${row.reservedEnd}`
    );
  }
  if (p.capacity) {
    lines.push("");
    lines.push("Room to grow:");
    lines.push(`  • ${p.capacity.noteRoles}`);
    lines.push(`  • ${p.capacity.noteSites}`);
    lines.push(`  • ${p.capacity.noteWithinRole}`);
  }
  lines.push("");
  lines.push("Notes:");
  lines.push("  • Greenfield scheme only — not brownfield IPAM.");
  if (p.warnings.length) {
    lines.push("");
    lines.push("Callouts:");
    for (const w of p.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("");
  lines.push("Generated offline in the browser. Confirm before production.");
  return lines.join("\n");
}

/**
 * @param {PlanRow[]} rows
 */
export function rowsToCsv(rows) {
  const header = [
    "building",
    "building_index",
    "role",
    "vlan",
    "devices_said",
    "sized_for",
    "suggested_prefix",
    "used_prefix",
    "subnet",
    "gateway",
    "usable",
    "reserved_lane",
    "reservation_ends",
    "reserved_range",
    "role_parent",
    "site_position",
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /["',\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.building,
        r.buildingIndex,
        r.role,
        r.vlanId,
        r.devicesSaid,
        r.sizedFor,
        r.suggestedPrefix,
        r.usedPrefix,
        r.subnet,
        r.gateway,
        r.usable,
        r.reservedLane,
        r.reservedEnd,
        r.reservedRange,
        r.roleParent,
        r.sitePosition,
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}
