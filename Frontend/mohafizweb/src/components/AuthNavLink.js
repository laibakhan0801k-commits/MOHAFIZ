"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function AuthNavLink() {
  const router = useRouter();
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser storage on mount
    setLoggedIn(!!localStorage.getItem("mohafiz_token"));
  }, []);

  if (loggedIn) {
    return (
      <button
        type="button"
        onClick={function () {
          localStorage.removeItem("mohafiz_token");
          localStorage.removeItem("mohafiz_user");
          setLoggedIn(false);
          router.push("/login");
        }}
        className="bg-ink text-paper text-sm rounded-full px-4 py-1.5 hover:opacity-90 transition"
      >
        Log out
      </button>
    );
  }

  return (
    <Link
      href="/login"
      className="bg-ink text-paper text-sm rounded-full px-4 py-1.5 hover:opacity-90 transition"
    >
      Log in
    </Link>
  );
}
