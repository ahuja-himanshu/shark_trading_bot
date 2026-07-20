import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SharkClient } from "../src/exchange/shark-client.js";

describe("Shark depth normalisation", () => {
  it("selects true best bid/ask regardless of depth row ordering", async () => {
    // Live Shark responses return bids ascending by price (worst first).
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            b: [
              ["0.001629", "16933982"],
              ["0.001648", "200"],
              ["0.001633", "11279511"],
            ],
            a: [
              ["0.001655", "100"],
              ["0.001651", "26023880"],
              ["0.001660", "50"],
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      fetchFn,
    });
    await expect(client.getBestBidAsk("PUMPUSDT")).resolves.toEqual({
      bestBid: "0.001648",
      bestAsk: "0.001651",
    });
  });
});

describe("Shark API signing", () => {
  it("signs the exact sorted GET query sent on the wire", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      now: () => 123456,
      fetchFn,
    });
    await client.getOpenOrders("BTCUSDT");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const query = new URL(url).searchParams.toString();
    expect(query).toBe(
      "pageSize=100&sortOrder=desc&symbol=BTCUSDT&timestamp=123456",
    );
    expect((init.headers as Record<string, string>).signature).toBe(
      createHmac("sha256", "secret").update(query).digest("hex"),
    );
  });

  it("keeps the request signal alive until the response body is consumed", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => {
          expect(requestSignal?.aborted).toBe(false);
          return "[]";
        },
      } as Response);
    });
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      now: () => 123456,
      fetchFn,
    });

    await client.getOpenOrders();

    expect(requestSignal?.aborted).toBe(true);
  });

  it("signs and sends the same canonical JSON body", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          clientOrderId: "order-1",
          symbol: "BTCUSDT",
          type: "MARKET",
          side: "BUY",
          price: 100000,
          orderAmount: 0.01,
          filledAmount: 0,
          marginAsset: "USDT",
        }),
        { status: 200 },
      ),
    );
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      now: () => 123456,
      fetchFn,
    });
    await client.placeOrder({
      placeType: "ORDER_FORM",
      quantity: "0.01",
      side: "BUY",
      symbol: "BTCUSDT",
      reduceOnly: false,
      marginAsset: "USDT",
      type: "MARKET",
    });
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    if (typeof init.body !== "string") throw new Error("Expected JSON body");
    const sentBody = JSON.parse(init.body) as Record<string, unknown>;
    expect(sentBody.quantity).toBe(0.01);
    expect(sentBody.timestamp).toBe("123456");
    expect((init.headers as Record<string, string>).signature).toBe(
      createHmac("sha256", "secret")
        .update(init.body as string)
        .digest("hex"),
    );
  });

  it("looks up an order through the documented path parameter", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      now: () => 123456,
      fetchFn,
    });

    await expect(client.getOrder("order/id with spaces")).resolves.toBeNull();

    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/v1/order/order%2Fid%20with%20spaces");
    expect(new URL(url).searchParams.toString()).toBe("timestamp=123456");
  });

  it("creates, renews, and deletes authenticated stream listen keys", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ listenKey: "listen-key-1234567890123456" }),
          { status: 200 },
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 }),
        ),
      );
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      now: () => 123456,
      fetchFn,
    });

    await expect(client.createListenKey()).resolves.toBe(
      "listen-key-1234567890123456",
    );
    await client.renewListenKey();
    await client.deleteListenKey();

    expect(
      fetchFn.mock.calls.map(([input, init]) => [
        new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input,
        ).pathname,
        init?.method,
      ]),
    ).toEqual([
      ["/v1/retail/listen-key", "POST"],
      ["/v1/retail/listen-key", "PUT"],
      ["/v1/retail/listen-key", "DELETE"],
    ]);
    for (const [, init] of fetchFn.mock.calls) {
      expect((init?.headers as Record<string, string>)["api-key"]).toBe("key");
      expect((init?.headers as Record<string, string>).signature).toHaveLength(
        64,
      );
    }
  });

  it("normalises documented market, wallet, position, and history responses", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
      let data: unknown;
      if (url.pathname === "/v1/exchange/exchangeInfo") {
        data = {
          conversionRates: { INR_MARGIN_USDT: 90 },
          contracts: [
            {
              name: "BTCUSDT",
              contractName: "Bitcoin",
              contractType: "PERPETUAL",
              baseAsset: "BTC",
              quoteAsset: "USDT",
              marginAssetsSupported: ["INR", "USDT"],
              maxLeverage: "20",
              pricePrecision: 2,
              quantityPrecision: 4,
              makerFee: "0.02",
              takerFee: "0.06",
              maintenanceMarginPercentage: "1",
              orderTypes: ["MARKET", "LIMIT"],
              filters: [
                {
                  filterType: "LIMIT_QTY_SIZE",
                  minQty: "0.001",
                  maxQty: "10",
                  stepSize: "0.001",
                },
                {
                  filterType: "PRICE_FILTER",
                  minPrice: "1",
                  maxPrice: "1000000",
                  tickSize: "0.1",
                },
                { filterType: "MIN_NOTIONAL", notional: 10 },
              ],
            },
            {
              name: "XAUUSDT",
              contractName: "Gold",
              contractType: "TRADIFI_PERPETUAL",
              baseAsset: "XAU",
              quoteAsset: "USDT",
              marginAssetsSupported: ["USDT"],
              maxLeverage: "10",
              pricePrecision: 2,
              quantityPrecision: 3,
              makerFee: "0.02",
              takerFee: "0.06",
              orderTypes: ["MARKET", "LIMIT"],
              filters: [],
            },
          ],
        };
      } else if (url.pathname.startsWith("/v1/market/depth/")) {
        data = { data: { b: [["99900", "1"]], a: [["100000", "1"]] } };
      } else if (url.pathname === "/v1/wallet/futures-wallet/details") {
        data = {
          marginAsset: "USDT",
          walletBalance: "100",
          withdrawableBalance: "90",
          lockedBalance: "10",
          marginBalance: "105",
          maintenanceMargin: "1",
          unrealisedPnlCross: "0",
          unrealisedPnlIsolated: "5",
        };
      } else if (
        url.pathname === "/v1/positions/OPEN" ||
        url.pathname === "/v1/positions"
      ) {
        data = [
          {
            positionId: "p1",
            contractPair: "BTCUSDT",
            positionStatus: "OPEN",
            positionType: "LONG",
            marginType: "ISOLATED",
            marginAsset: "USDT",
            quoteAsset: "USDT",
            baseAsset: "BTC",
            entryPrice: 90000,
            liquidationPrice: 81000,
            margin: 100,
            marginInMarginAsset: 100,
            quantity: 0.01,
            positionSize: 900,
            leverage: 10,
            realizedProfit: 0,
            createdAt: "2026-07-01T00:00:00Z",
          },
        ];
      } else if (url.pathname === "/v1/user-data/trade-history") {
        data = [
          {
            id: 1,
            clientOrderId: "o1",
            symbol: "BTCUSDT",
            side: "SELL",
            type: "MARKET",
            price: 100000,
            quantity: 0.01,
            fee: 1,
            realizedProfit: 100,
            marginAsset: "USDT",
            time: "2026-07-17T00:00:00Z",
          },
        ];
      } else if (url.pathname === "/v1/user-data/transaction-history") {
        data = [
          {
            id: 2,
            type: "FUNDING_FEE",
            amount: -2,
            asset: "USDT",
            symbol: "BTCUSDT",
            time: "2026-07-17T00:00:00Z",
          },
        ];
      } else {
        data = { success: true };
      }
      return Promise.resolve(
        new Response(JSON.stringify(data), { status: 200 }),
      );
    });
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      now: () => 123456,
      fetchFn,
    });
    const contracts = await client.getContracts();
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      symbol: "BTCUSDT",
      conversionRates: { INR_MARGIN_USDT: "90" },
      makerFeeRate: "0.0002",
      takerFeeRate: "0.0006",
    });
    expect(contracts[0]?.filters).toContainEqual({
      filterType: "PRICE_FILTER",
      minPrice: "1",
      maxPrice: "1000000",
      tickSize: "0.1",
    });
    expect(await client.getBestBidAsk("BTCUSDT")).toEqual({
      bestBid: "99900",
      bestAsk: "100000",
    });
    expect((await client.getWallet("USDT")).withdrawableBalance).toBe("90");
    expect((await client.getPositions())[0]?.positionId).toBe("p1");
    expect((await client.getPosition("p1"))?.quantity).toBe("0.01");
    expect((await client.getTradeHistory())[0]?.realisedProfit).toBe("100");
    expect((await client.getTransactionHistory())[0]?.type).toBe("FUNDING_FEE");
  });

  it("calls every documented mutating management endpoint without exposing fund movement", async () => {
    const paths: string[] = [];
    const bodies: unknown[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
      paths.push(url.pathname);
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
        }),
      );
    });
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      now: () => 123456,
      fetchFn,
    });
    await client.updatePreference("BTCUSDT", 10, "ISOLATED");
    await client.cancelOrder("order-1");
    await client.cancelAllOrders();
    await client.closeAllPositions();
    await client.setProtection({
      positionId: "p1",
      stopLosses: [{ quantity: "0.01", price: "80000" }],
    });
    expect(paths).toEqual([
      "/v1/exchange/update/preference",
      "/v1/order/delete-order",
      "/v1/order/cancel-all-orders",
      "/v1/positions/close-all-positions",
      "/v2/order/split-tp-sl",
    ]);
    expect(bodies.at(-1)).toMatchObject({
      splitStopLossOrders: [{ quantity: 0.01, price: 80000 }],
    });
  });

  it("classifies failed mutating network calls as ambiguous and does not retry", async () => {
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout")),
    });
    await expect(
      client.placeOrder({
        placeType: "ORDER_FORM",
        quantity: "0.01",
        side: "BUY",
        symbol: "BTCUSDT",
        reduceOnly: false,
        marginAsset: "USDT",
        type: "MARKET",
      }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_MUTATION", retryable: false });
  });

  it("fails closed on malformed position directions or timestamps", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            positionId: "p1",
            contractPair: "BTCUSDT",
            positionStatus: "OPEN",
            positionType: "SIDEWAYS",
            marginType: "ISOLATED",
            marginAsset: "USDT",
            quoteAsset: "USDT",
            baseAsset: "BTC",
            entryPrice: 90000,
            liquidationPrice: 81000,
            margin: 100,
            marginInMarginAsset: 100,
            quantity: 0.01,
            positionSize: 900,
            leverage: 10,
            createdAt: "not-a-date",
          },
        ]),
        { status: 200 },
      ),
    );
    const client = new SharkClient({
      baseUrl: "https://api.sharkexchange.in",
      apiKey: "key",
      apiSecret: "secret",
      fetchFn,
    });

    await expect(client.getPositions()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });
});
