// The React page of the fixture app (/react): a little of everything
// the react step reads. The tests build it, as a dev server would, into
// react-dist with a source map.
import { Component, createContext, memo, Suspense, use, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error: React's types leave the compiler's runtime out, as it is only for compiled code.
import { c as useMemoCache } from "react/compiler-runtime";

// The library the page loads from /node_modules/fake-lib/index.js (fake-lib.js here), given this React.
type FakeLib = {
  useFakeQuery: (key: string[]) => { status: string; data: string[] | null; error: unknown };
  FakeButton: (props: { children: ReactNode; onClick?: () => void }) => ReactNode;
  FakeBoundary: new (props: { children: ReactNode }) => Component<{ children: ReactNode }>;
};
const Lib = (window as unknown as { makeFakeLib: (react: typeof React) => FakeLib }).makeFakeLib(React);

const ThemeContext = createContext("light");
ThemeContext.displayName = "ThemeContext";

function Header({ title }: { title: string; apiKey?: string }) {
  const theme = useContext(ThemeContext);
  return <h1 className={theme}>{title}</h1>;
}

function Counter({ step }: { step: number }) {
  const [count, setCount] = useState(0);
  const doubled = useMemo(() => count * 2, [count]);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.title = `count ${count}`;
  }, [count]);
  return (
    <button ref={button} onClick={() => setCount(count + step)}>
      count {count} (doubled {doubled})
    </button>
  );
}

// A store outside React, read the way state libraries do.
const online = { value: true, listeners: new Set<() => void>() };
const subscribe = (listener: () => void) => {
  online.listeners.add(listener);
  return () => online.listeners.delete(listener);
};

function Status() {
  const isOnline = useSyncExternalStore(subscribe, () => online.value);
  const [note] = useState("ok");
  return (
    <p>
      {isOnline ? "online" : "offline"} {note}
    </p>
  );
}

type Item = { id: string; name: string; qty: number };

function CartItem({ item }: { item: Item }) {
  return (
    <li>
      {item.name} × {item.qty}
    </li>
  );
}
const MemoCartItem = memo(CartItem);

function Total({ items }: { items: Item[] }) {
  return <p>total {items.reduce((sum, item) => sum + item.qty, 0)}</p>;
}

function Cart() {
  const [items, setItems] = useState<Item[]>([
    { id: "sku-1", name: "Socks", qty: 2 },
    { id: "sku-2", name: "Hat", qty: 1 },
  ]);
  const [, setTick] = useState(0);
  const more = () => setItems((now) => now.map((item) => (item.id === "sku-1" ? { ...item, qty: item.qty + 1 } : item)));
  return (
    <section>
      <ul>
        {items.map((item) => (
          <MemoCartItem key={item.id} item={item} />
        ))}
      </ul>
      <Total items={items} />
      <button onClick={more}>More socks</button>
      <button onClick={() => setTick((tick) => tick + 1)}>Refresh</button>
      <button onClick={() => setItems((now) => now.filter((item) => item.id !== "sku-2"))}>Remove hat</button>
    </section>
  );
}

const products = new Promise<string[]>((done) => setTimeout(() => done(["Kettle", "Lamp"]), 200));

function Products() {
  const list = use(products);
  return <p>products: {list.join(", ")}</p>;
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p role="alert">checkout broke</p> : this.props.children;
  }
}

// The app's own component using the library's hook, button and boundary.
function Items() {
  const query = Lib.useFakeQuery(["items"]);
  return (
    <Lib.FakeBoundary>
      <Lib.FakeButton>items {query.status}</Lib.FakeButton>
    </Lib.FakeBoundary>
  );
}

// What the React Compiler makes of a component: its results kept in a cache.
function Compiled({ label }: { label: string }) {
  const $ = useMemoCache(2);
  let shown;
  if ($[0] !== label) {
    shown = <span>{label}</span>;
    $[0] = label;
    $[1] = shown;
  } else {
    shown = $[1];
  }
  return shown;
}

// A wrapper: what it shows is written by whoever uses it.
function Card({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>;
}

function Checkout({ explode = false }: { explode?: boolean }) {
  if (explode) throw new Error("checkout exploded");
  return <button>Pay</button>;
}

function App() {
  const [theme, setTheme] = useState("light");
  return (
    <ThemeContext value={theme}>
      <Header title="React fixture" apiKey="sk-fixture-secret" />
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Theme {theme}</button>
      <Counter step={1} />
      <Status />
      <Cart />
      <Suspense fallback={<p>loading products</p>}>
        <Products />
      </Suspense>
      <Boundary>
        <Checkout />
      </Boundary>
      <Card>
        <p>inside a card</p>
      </Card>
      <Items />
      <Compiled label={`theme ${theme}`} />
    </ThemeContext>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
