import { useEffect, useState } from "react";

export default function AnimatedDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setCount((c) => (c % 3) + 1), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="animated-dots">
      {".".repeat(count)}
      <span style={{ visibility: "hidden" }}>{".".repeat(3 - count)}</span>
    </span>
  );
}
