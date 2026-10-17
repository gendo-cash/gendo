// The Minswap adapter's script for a network: the compiled validator with that
// network's Minswap deployment applied (onchain/validators/apps/minswap.ak).
import { applyDoubleCborEncoding, applyParamsToScript, validatorToRewardAddress, validatorToScriptHash, type Network, type Script } from "@lucid-evolution/lucid";
import blueprint from "../../../../../onchain/plutus.json" with { type: "json" };
import { appFor } from "../catalogue.js";

export function minswapAdapter(network: Network): { script: Script; hash: string; rewardAddress: string } {
  const found = appFor("minswap", network);
  if (!found) throw new Error(`Minswap isn't deployed on ${network}`);
  const v = blueprint.validators.find((x: { title: string }) => x.title === "apps/minswap.minswap.withdraw");
  if (!v) throw new Error("Minswap adapter not found in the blueprint");
  const d = found.network.deployment;
  const script: Script = { type: "PlutusV3", script: applyDoubleCborEncoding(applyParamsToScript(v.compiledCode, [d.lpPolicy, d.poolScript, d.orderScript])) };
  return { script, hash: validatorToScriptHash(script), rewardAddress: validatorToRewardAddress(network, script) };
}
