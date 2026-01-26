package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"crypto/subtle"
	"time"
		"fmt"
	
		"codex-app-server/internal/appserver"
	)
	
	type rpcRequest struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params,omitempty"`
	}
	
	func main() {
		logger := log.New(os.Stdout, "[codex-http] ", log.LstdFlags|log.Lmicroseconds)
	
		// Optional shared secret for HTTP access. When empty, / is open.
		secret := os.Getenv("CODEX_HTTP_SECRET")
	
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
	
		client, err := appserver.New(ctx, logger, "codex", []string{"app-server"})
		if err != nil {
			logger.Fatalf("failed to start codex app-server: %v", err)
		}
	
		mux := http.NewServeMux()
	
		mux.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) {
		// logger.Printf("incoming HTTP request path=%s remote=%s", r.URL.Path, r.RemoteAddr)

		if secret != "" {
			header := r.Header.Get("x-codex-secret")
			if header == "" || subtle.ConstantTimeCompare([]byte(header), []byte(secret)) != 1 {
				// logger.Printf("unauthorized request path=%s remote=%s", r.URL.Path, r.RemoteAddr)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		// SSE headers
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		ch, cancel := client.SubscribeNotifications()
		defer cancel()

		for {
			select {
			case <-r.Context().Done():
				// logger.Printf("events stream closed remote=%s", r.RemoteAddr)
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				// One JSON object per SSE message.
				if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
					// logger.Printf("events stream write failed remote=%s: %v", r.RemoteAddr, err)
					return
				}
				flusher.Flush()
			}
		}
	})

	mux.HandleFunc("POST /", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		logger.Printf("incoming HTTP request path=%s remote=%s", r.URL.Path, r.RemoteAddr)

		if secret != "" {
			header := r.Header.Get("x-codex-secret")
			if header == "" || subtle.ConstantTimeCompare([]byte(header), []byte(secret)) != 1 {
				logger.Printf("unauthorized request path=%s remote=%s", r.URL.Path, r.RemoteAddr)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}

		var req rpcRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			logger.Printf("invalid JSON body path=%s remote=%s: %v", r.URL.Path, r.RemoteAddr, err)
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if req.Method == "" {
			logger.Printf("missing method in request path=%s remote=%s", r.URL.Path, r.RemoteAddr)
			http.Error(w, "missing method", http.StatusBadRequest)
			return
		}

		callCtx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
		defer cancel()

		rawParams := req.Params
		if len(rawParams) == 0 {
			rawParams = nil
		}

		respBytes, err := client.Call(callCtx, req.Method, rawParams)
		if err != nil {
			logger.Printf("rpc call error method=%s remote=%s duration=%s: %v", req.Method, r.RemoteAddr, time.Since(start), err)
			http.Error(w, "rpc call failed", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write(respBytes); err != nil {
			logger.Printf("failed to write HTTP response method=%s remote=%s duration=%s: %v", req.Method, r.RemoteAddr, time.Since(start), err)
			return
		}

		logger.Printf("completed HTTP request method=%s path=%s remote=%s duration=%s", req.Method, r.URL.Path, r.RemoteAddr, time.Since(start))
	})

	addr := ":8080"
	if v := os.Getenv("PORT"); v != "" {
		addr = ":" + v
	}

	server := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		// Disable write timeout to allow long-lived SSE connections on /events.
		WriteTimeout: 0,
	}

	go func() {
		logger.Printf("HTTP server listening on %s", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("http server error: %v", err)
		}
	}()

	<-ctx.Done()
	logger.Println("shutting down HTTP server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Printf("HTTP server shutdown error: %v", err)
	}

	client.Close()
}
