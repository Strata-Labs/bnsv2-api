import fetch from "node-fetch";
import cache from "./cache.js";

const BURN_BLOCK_CACHE_KEY = {
  mainnet: "mainnet_burn_block_height",
  testnet: "testnet_burn_block_height",
};

export async function getCurrentBurnBlockHeight(network) {
  const cacheKey = BURN_BLOCK_CACHE_KEY[network];

  const cachedHeight = cache.get(cacheKey);
  if (cachedHeight !== undefined) {
    return cachedHeight;
  }

  const apiUrl =
    network === "testnet"
      ? "https://api.testnet.hiro.so"
      : "https://api.hiro.so";

  const response = await fetch(`${apiUrl}/extended/v2/burn-blocks?limit=1`);

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  const burnBlockHeight = data.results[0].burn_block_height;

  cache.set(cacheKey, burnBlockHeight);

  return burnBlockHeight;
}
