export function decodeZonefile(zonefileHex) {
  if (!zonefileHex) return null;
  try {
    const hex = zonefileHex.replace("0x", "");
    const decoded = Buffer.from(hex, "hex").toString("utf8");
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  } catch (error) {
    console.error("Error decoding zonefile:", error);
    return null;
  }
}

export function hasValidBaseFields(zonefile) {
  try {
    const baseFields = [
      "owner",
      "general",
      "twitter",
      "url",
      "nostr",
      "lightning",
      "btc",
    ];

    for (const field of baseFields) {
      if (typeof zonefile[field] !== "string") {
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error("Error validating zonefile base fields:", error);
    return false;
  }
}

export function hasValidSubdomainStructure(zonefile) {
  try {
    const hasExternalFile =
      "externalSubdomainFile" in zonefile &&
      typeof zonefile.externalSubdomainFile === "string";
    const hasSubdomains = "subdomains" in zonefile;

    if (hasExternalFile && hasSubdomains) {
      return false;
    }

    if (hasExternalFile) {
      return true;
    }

    if (!hasSubdomains) {
      return false;
    }

    const subdomains = zonefile.subdomains;
    if (
      typeof subdomains !== "object" ||
      subdomains === null ||
      Array.isArray(subdomains)
    ) {
      return false;
    }

    for (const subName in subdomains) {
      const subProps = subdomains[subName];
      if (typeof subProps !== "object" || subProps === null) {
        return false;
      }

      if (!hasValidBaseFields(subProps)) {
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error("Error validating zonefile subdomain structure:", error);
    return false;
  }
}

export function isValidZonefileFormat(zonefile) {
  try {
    if (!hasValidBaseFields(zonefile)) {
      return false;
    }

    if ("subdomains" in zonefile || "externalSubdomainFile" in zonefile) {
      return hasValidSubdomainStructure(zonefile);
    }

    return true;
  } catch (error) {
    console.error("Error validating zonefile:", error);
    return false;
  }
}

export function hasValidBtcAddress(zonefile) {
  return (
    zonefile && typeof zonefile.btc === "string" && zonefile.btc.trim() !== ""
  );
}

export function getAndValidateZonefile(zonefileHex, owner) {
  const decodedZonefile = decodeZonefile(zonefileHex);

  if (!decodedZonefile) {
    return {
      success: false,
      error: "No zonefile found or unable to decode",
      code: 404,
    };
  }

  if (!isValidZonefileFormat(decodedZonefile)) {
    return {
      success: false,
      error: "Invalid zonefile format",
      code: 400,
    };
  }

  if (decodedZonefile.owner !== owner) {
    return {
      success: false,
      error: "Zonefile needs to be updated (owner mismatch)",
      code: 400,
    };
  }

  return {
    success: true,
    zonefile: decodedZonefile,
  };
}
