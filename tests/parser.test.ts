import { describe, expect, it } from "vitest";
import { CommandParseError, parseCommand } from "../src/commands/parser.js";

describe("command parser", () => {
  it("parses an isolated USDT market trade and treats margin as capital", () => {
    expect(
      parseCommand("/trade BTCUSDT long market margin 100 USDT leverage 10"),
    ).toEqual({
      kind: "TRADE",
      symbolInput: "BTCUSDT",
      direction: "LONG",
      orderType: "MARKET",
      marginAmount: "100",
      requestedMarginAsset: "USDT",
      leverage: 10,
      marginMode: "ISOLATED",
    });
  });

  it("parses explicit cross and limit price", () => {
    expect(
      parseCommand(
        "/trade BTC short limit 90000 margin 5000 INR leverage 5 cross",
      ),
    ).toMatchObject({
      direction: "SHORT",
      orderType: "LIMIT",
      limitPrice: "90000",
      marginMode: "CROSS",
    });
  });

  it.each([
    "/trade BTC long market margin 100 leverage 10",
    "/trade BTC long market margin 100 USD leverage 10",
    "/close BTC market 100",
    "/pnl 2026-08-01 2026-07-01",
  ])("rejects ambiguous or invalid command: %s", (command) => {
    expect(() => parseCommand(command)).toThrow(CommandParseError);
  });

  it("parses close-all as an explicit action", () => {
    expect(parseCommand("/close all")).toEqual({ kind: "CLOSE_ALL" });
  });

  it.each([
    ["/help", "HELP"],
    ["/health", "HEALTH"],
    ["/wallet", "WALLET"],
    ["/wallet INR", "WALLET"],
    ["/markets btc", "MARKETS"],
    ["/default_market usdt", "DEFAULT_MARKET"],
    ["/open_positions", "OPEN_POSITIONS"],
    ["/position BTCUSDT", "POSITION"],
    ["/open_orders", "OPEN_ORDERS"],
    ["/open_orders BTCUSDT", "OPEN_ORDERS"],
    ["/pnl open", "PNL"],
    ["/pnl today", "PNL"],
    ["/pnl all", "PNL"],
    ["/pnl 2026-07-01 2026-07-17", "PNL"],
    ["/audit T-ABCDEF012345", "AUDIT"],
    ["/close BTCUSDT market", "CLOSE"],
    ["/close BTCUSDT limit 99999", "CLOSE"],
    ["/cancel_orders", "CANCEL_ORDERS"],
    ["/cancel_orders BTCUSDT", "CANCEL_ORDERS"],
    ["/sl BTCUSDT 85000", "PROTECTION"],
    ["/tp BTCUSDT 110000", "PROTECTION"],
    ["/edit T-ABCDEF012345 margin 200 USDT", "EDIT"],
    ["/cancel T-ABCDEF012345", "CANCEL"],
  ])("parses supported command %s", (command, kind) => {
    expect(parseCommand(command).kind).toBe(kind);
  });

  it.each([
    "hello",
    "/unknown",
    "/wallet EUR",
    "/markets",
    "/default_market EUR",
    "/open_positions extra",
    "/position BTC extra",
    "/open_orders BTC extra",
    "/pnl yesterday",
    "/audit",
    "/trade BTC sideways market margin 10 INR leverage 2",
    "/trade BTC long stop margin 10 INR leverage 2",
    "/trade BTC long limit margin 10 INR leverage 2",
    "/trade BTC long market margin -1 INR leverage 2",
    "/trade BTC long market margin 1 INR leverage 0",
    "/trade BTC long market margin 1 INR leverage 2 shared",
    "/close",
    "/close BTC limit",
    "/cancel_orders BTC ETH",
    "/sl BTC -1",
    "/edit T-X strange value",
  ])("rejects unsupported syntax %s", (command) => {
    expect(() => parseCommand(command)).toThrow(CommandParseError);
  });
});
