// A stand-in for a library, served from a node_modules address
// (/node_modules/fake-lib/index.js) so the tests can tell a library's
// components and hooks from the app's own. It takes the app's React.
window.makeFakeLib = (React) => {
  let state = { status: "pending", data: null, error: null };
  const listeners = new Set();
  setTimeout(() => {
    state = { status: "success", data: ["a", "b"], error: null };
    for (const listener of listeners) listener();
  }, 150);

  // Like a query hook: an observer holding its key, an effect, and a store.
  function useFakeQuery(key) {
    const [observer] = React.useState(() => ({ options: { queryKey: key } }));
    React.useEffect(() => {}, [observer]);
    return React.useSyncExternalStore(
      (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      () => state,
    );
  }

  function FakeButton(props) {
    return React.createElement("button", { className: "fake-button", onClick: props.onClick }, props.children);
  }

  class FakeBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { failed: false };
    }
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      return this.state.failed ? React.createElement("p", null, "fake boundary caught it") : this.props.children;
    }
  }

  return { useFakeQuery, FakeButton, FakeBoundary };
};
