import "./styles.css";
import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchStreamLink } from "@trpc/client";
import { trpc } from "./trpc.ts";
import { profileHeaders } from "./lib/profile.ts";
import { installExclusiveAudio } from "./lib/exclusive-audio.ts";
import { installBreadcrumbs } from "./lib/breadcrumbs.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { UpdateProgress } from "./components/UpdateProgress.tsx";
import { Home } from "./pages/Home.tsx";
import { BookDetail } from "./pages/BookDetail.tsx";
import { Chat } from "./pages/Chat.tsx";
// Lazy so every other page stops paying for pdf.js
const Reader = lazy(() => import("./pages/Reader.tsx").then((m) => ({ default: m.Reader })));
const Components = lazy(() => import("./pages/Components.tsx").then((m) => ({ default: m.Components })));
const ReaderOpen = lazy(() => import("./pages/ReaderOpen.tsx").then((m) => ({ default: m.ReaderOpen })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchStreamLink({
      url: "/trpc",
      headers: () => profileHeaders(),
    }),
  ],
});

installBreadcrumbs();
installExclusiveAudio();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ErrorBoundary>
            <UpdateProgress />
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/folders/:folderId" element={<Home />} />
              <Route path="/books/:id" element={<BookDetail />} />
              <Route path="/books/:id/read" element={<Suspense fallback={null}><Reader /></Suspense>} />
              <Route path="/open" element={<Suspense fallback={null}><ReaderOpen /></Suspense>} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/components" element={<Suspense fallback={null}><Components /></Suspense>} />
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>
);
