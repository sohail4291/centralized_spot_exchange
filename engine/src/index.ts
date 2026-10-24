
import "dotenv/config";
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { env } from "./utils/env.js";

import type {
  RestingOrder,
  OrderRecord,
  Fill,
  OrderBook,
} from "./store/exchange-store.js";

import {
  ORDERBOOKS,
  ORDERS,
  FILLS,
} from "./store/exchange-store.js";

export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// Redis clients
const brokerClient = createClient({ url: env.redisUrl });
const responseClient = createClient({ url: env.redisUrl });

brokerClient.on("error", (error) =>
  console.error("Broker Redis error:", error)
);

responseClient.on("error", (error) =>
  console.error("Response Redis error:", error)
);

await Promise.all([
  brokerClient.connect(),
  responseClient.connect(),
]);

async function sendResponse(
  responseQueue: string,
  response: EngineResponse
): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

// Dummy seller: SOL, price 299, quantity 5
// Remove this block when connecting real order data.
const solBook: OrderBook = {
  bids: new Map(),
  asks: new Map(),
};

const dummySeller: RestingOrder = {
  orderId: "dummy-sell-order-1",
  userId: "seller-1",
  side: "sell",
  type: "limit",
  symbol: "SOL",
  price: 299,
  qty: 5,
  filledQty: 0,
  status: "open",
  createdAt: Date.now(),
};

solBook.asks.set(299, [dummySeller]);
ORDERBOOKS.set("SOL", solBook);

const dummyRecord: OrderRecord = {
  ...dummySeller,
  fills: [],
};
ORDERS.set(dummySeller.orderId, dummyRecord);

console.log("Dummy SOL order book initialized");

// Create order and match it against the opposite side
function createOrder(payload: Record<string, unknown>) {
  if (typeof payload.symbol !== "string" || !payload.symbol.trim()) {
    throw new Error("Invalid symbol");
  }

  if (typeof payload.userId !== "string" || !payload.userId.trim()) {
    throw new Error("Invalid userId");
  }

  if (payload.side !== "buy" && payload.side !== "sell") {
    throw new Error("Invalid side: use buy or sell");
  }

  if (
    typeof payload.price !== "number" ||
    !Number.isFinite(payload.price) ||
    payload.price <= 0
  ) {
    throw new Error("Invalid price");
  }

  if (
    typeof payload.qty !== "number" ||
    !Number.isFinite(payload.qty) ||
    payload.qty <= 0
  ) {
    throw new Error("Invalid quantity");
  }

  const symbol = payload.symbol;
  const side = payload.side;
  const price = payload.price;
  const qty = payload.qty;
  const userId = payload.userId;

  let book = ORDERBOOKS.get(symbol);

  if (!book) {
    book = {
      bids: new Map(),
      asks: new Map(),
    };
    ORDERBOOKS.set(symbol, book);
  }

  const order: RestingOrder = {
    orderId: randomUUID(),
    userId,
    side,
    type: "limit",
    symbol,
    price,
    qty,
    filledQty: 0,
    status: "open",
    createdAt: Date.now(),
  };

  const opposite = side === "buy" ? book.asks : book.bids;

  // Buyers match lowest asks first; sellers match highest bids first.
  const prices = [...opposite.keys()].sort((a, b) =>
    side === "buy" ? a - b : b - a
  );

  const fills: Fill[] = [];

  for (const matchPrice of prices) {
    if (
      (side === "buy" && matchPrice > price) ||
      (side === "sell" && matchPrice < price)
    ) {
      break;
    }

    const restingOrders = opposite.get(matchPrice);
    if (!restingOrders) continue;

    let i = 0;

    while (i < restingOrders.length && order.filledQty < order.qty) {
      const resting = restingOrders[i];
      if (!resting) {
        i++;
        continue;
      }

      // Prevent an order from matching against itself.
      if (resting.userId === order.userId) {
        i++;
        continue;
      }

      const incomingRemaining = order.qty - order.filledQty;
      const restingRemaining = resting.qty - resting.filledQty;

      if (restingRemaining <= 0) {
        restingOrders.splice(i, 1);
        continue;
      }

      const tradeQty = Math.min(incomingRemaining, restingRemaining);

      order.filledQty += tradeQty;
      resting.filledQty += tradeQty;

      resting.status =
        resting.filledQty >= resting.qty ? "filled" : "partially_filled";

      const fill: Fill = {
        fillId: randomUUID(),
        symbol,
        price: resting.price,
        qty: tradeQty,
        buyOrderId: side === "buy" ? order.orderId : resting.orderId,
        sellOrderId: side === "sell" ? order.orderId : resting.orderId,
        createdAt: Date.now(),
      };

      fills.push(fill);
      FILLS.push(fill);

      // Update the resting order's saved record.
      const restingRecord = ORDERS.get(resting.orderId);
      if (restingRecord) {
        restingRecord.filledQty = resting.filledQty;
        restingRecord.status = resting.status;
        restingRecord.fills.push(fill);
      }

      if (resting.filledQty >= resting.qty) {
        restingOrders.splice(i, 1);
      } else {
        i++;
      }
    }

    if (restingOrders.length === 0) {
      opposite.delete(matchPrice);
    }

    if (order.filledQty >= order.qty) break;
  }

  if (order.filledQty >= order.qty) {
    order.status = "filled";
  } else if (order.filledQty > 0) {
    order.status = "partially_filled";
  } else {
    order.status = "open";
  }

  // Store any unfilled quantity in the book.
  if (order.filledQty < order.qty) {
    const ownSide = side === "buy" ? book.bids : book.asks;
    const ordersAtPrice = ownSide.get(price) ?? [];

    ordersAtPrice.push(order);
    ownSide.set(price, ordersAtPrice);
  }

  const record: OrderRecord = {
    ...order,
    fills,
  };

  ORDERS.set(order.orderId, record);

  const tradedValue = fills.reduce(
    (sum, fill) => sum + fill.price * fill.qty,
    0
  );

  return {
    orderId: order.orderId,
    symbol,
    side,
    status: order.status,
    price,
    qty,
    filledQty: order.filledQty,
    remainingQty: qty - order.filledQty,
    averagePrice:
      order.filledQty > 0 ? tradedValue / order.filledQty : null,
    fills,
  };
}

function getDepth(payload: Record<string, unknown>) {
  if (typeof payload.symbol !== "string") {
    throw new Error("Invalid symbol");
  }

  const book = ORDERBOOKS.get(payload.symbol);

  if (!book) {
    return { symbol: payload.symbol, bids: [], asks: [] };
  }

  const toLevels = (levels: Map<number, RestingOrder[]>) =>
    [...levels.entries()]
      .map(([price, orders]) => ({
        price,
        qty: orders.reduce(
          (sum, order) => sum + order.qty - order.filledQty,
          0
        ),
      }))
      .filter((level) => level.qty > 0)
      .sort((a, b) => b.price - a.price);

  return {
    symbol: payload.symbol,
    bids: toLevels(book.bids),
    asks: toLevels(book.asks).sort((a, b) => a.price - b.price),
  };
}

function handleEngineRequest(message: EngineRequest): unknown {
  switch (message.type) {
    case "create_order":
      return createOrder(message.payload);

    case "get_depth":
      return getDepth(message.payload);

    case "get_order": {
      if (typeof message.payload.orderId !== "string") {
        throw new Error("Invalid orderId");
      }

      const order = ORDERS.get(message.payload.orderId);
      if (!order) throw new Error("Order not found");

      return order;
    }

    case "get_user_balance": {
      if (typeof message.payload.userId !== "string") {
        throw new Error("Invalid userId");
      }

      const balance = (awaitBalance => awaitBalance)(
        undefined
      );

      // Balance retrieval depends on your BALANCES map structure.
      // Implement this after defining the asset symbol in the request.
      throw new Error("get_user_balance is not implemented");
    }

    case "cancel_order": {
      if (typeof message.payload.orderId !== "string") {
        throw new Error("Invalid orderId");
      }

      const order = ORDERS.get(message.payload.orderId);
      if (!order) throw new Error("Order not found");
      if (order.status !== "open" && order.status !== "partially_filled") {
        throw new Error("Order cannot be cancelled");
      }

      const book = ORDERBOOKS.get(order.symbol);
      if (!book) throw new Error("Order book not found");

      const ownSide = order.side === "buy" ? book.bids : book.asks;
      const restingOrders = ownSide.get(order.price!);

      if (restingOrders) {
        const index = restingOrders.findIndex(
          (item) => item.orderId === order.orderId
        );

        if (index !== -1) restingOrders.splice(index, 1);
        if (restingOrders.length === 0) ownSide.delete(order.price!);
      }

      order.status = "cancelled";
      return order;
    }

    default:
      throw new Error("Unsupported command");
  }
}

console.log("Order book:", ORDERBOOKS);
console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);















for (;;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    console.log("Received:", message.type, message.payload);

    const data = handleEngineRequest(message);

    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}
