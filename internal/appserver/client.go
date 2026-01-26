package appserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// Client manages a single codex app-server process and JSON-RPC style requests over stdio.
type Client struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	logger *log.Logger

	nextID  atomic.Int64
	mu      sync.Mutex
	pending map[int64]chan []byte

	cancel context.CancelFunc

			subMu       sync.Mutex

			nextSubID   atomic.Int64

			subscribers map[int64]chan []byte

		}

		

		// rpcEnvelope is a loose representation of codex app-server messages.

		type rpcEnvelope struct {

			ID     *int64          `json:"id,omitempty"`

			Method string          `json:"method,omitempty"`

			Result json.RawMessage `json:"result,omitempty"`

			Error  json.RawMessage `json:"error,omitempty"`

			Params json.RawMessage `json:"params,omitempty"`

		}

		

		// New starts the codex app-server process and performs the initialize handshake.

		func New(ctx context.Context, logger *log.Logger, binary string, args []string) (*Client, error) {

			if logger == nil {

				logger = log.Default()

			}

		

			cmd := exec.CommandContext(ctx, binary, args...)

			stdin, err := cmd.StdinPipe()

			if err != nil {

				return nil, fmt.Errorf("stdin pipe: %w", err)

			}

			stdout, err := cmd.StdoutPipe()

			if err != nil {

				return nil, fmt.Errorf("stdout pipe: %w", err)

			}

		

			clientCtx, cancel := context.WithCancel(ctx)

			c := &Client{

				cmd:         cmd,

				stdin:       stdin,

				logger:      logger,

				pending:     make(map[int64]chan []byte),

				cancel:      cancel,

				subscribers: make(map[int64]chan []byte),

			}

		

			if err := cmd.Start(); err != nil {

				cancel()

				return nil, fmt.Errorf("start codex app-server: %w", err)

			}

		

			go c.readLoop(clientCtx, stdout)

		

			// Perform initialize / initialized handshake.

			initParams := map[string]any{

				"clientInfo": map[string]any{

					"name":    "codex_http_bridge",

					"title":   "Codex HTTP Bridge",

					"version": "0.1.0",

				},

			}

		

			if _, err := c.Call(clientCtx, "initialize", initParams); err != nil {

				c.Close()

				return nil, fmt.Errorf("initialize: %w", err)

			}

		

			// Send initialized notification (no response expected).

			if err := c.sendNotification(map[string]any{

				"method": "initialized",

				"params": map[string]any{},

			}); err != nil {

				c.Close()

				return nil, fmt.Errorf("initialized notify: %w", err)

			}

		

			logger.Println("codex app-server initialized")

			return c, nil

		}

		

		// SubscribeNotifications returns a channel that receives every notification emitted by codex app-server

		// (messages with no `id`). Caller must call the returned cancel function.

		func (c *Client) SubscribeNotifications() (<-chan []byte, func()) {

			id := c.nextSubID.Add(1)

			ch := make(chan []byte, 256)

		

			c.subMu.Lock()

			c.subscribers[id] = ch

			c.subMu.Unlock()

		

			cancel := func() {

				c.subMu.Lock()

				existing, ok := c.subscribers[id]

				if ok {

					delete(c.subscribers, id)

				}

				c.subMu.Unlock()

				if ok {

					close(existing)

				}

			}

		

			return ch, cancel

		}

		

		func (c *Client) broadcastNotification(line []byte) {

			c.subMu.Lock()

			defer c.subMu.Unlock()

			for id, ch := range c.subscribers {

				// Copy since scanner's buffer is reused.

				msg := append([]byte(nil), line...)

				select {

				case ch <- msg:

				default:

					c.logger.Printf("dropping notification for subscriber=%d (listener slow)", id)

				}

			}

		}

		

		// Call sends a request with a method and params and waits for the matching response line.
// Params may be a Go value or json.RawMessage (already-encoded params object).
func (c *Client) Call(ctx context.Context, method string, params any) ([]byte, error) {
	if method == "" {
		return nil, errors.New("method is required")
	}

	id := c.nextID.Add(1)
	ch := make(chan []byte, 1)

	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	msg := map[string]any{
		"method": method,
		"id":     id,
	}
	if params != nil {
		msg["params"] = params
	}

	if err := c.encodeAndWrite(msg); err != nil {
		c.removePending(id)
		return nil, err
	}

	select {
	case <-ctx.Done():
		c.removePending(id)
		return nil, ctx.Err()
	case line, ok := <-ch:
		if !ok {
			return nil, errors.New("connection closed before response")
		}
		return line, nil
	}
}

// Close stops the client and underlying process.
func (c *Client) Close() {
	c.cancel()
	_ = c.stdin.Close()
	_ = c.cmd.Process.Kill()
}

func (c *Client) removePending(id int64) {
	c.mu.Lock()
	ch, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if ok {
		close(ch)
	}
}

func (c *Client) sendNotification(msg map[string]any) error {
	return c.encodeAndWrite(msg)
}

func (c *Client) encodeAndWrite(msg map[string]any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode message: %w", err)
	}
	data = append(data, '\n')

	if _, err := c.stdin.Write(data); err != nil {
		return fmt.Errorf("write to codex app-server: %w", err)
	}
	return nil
}

func (c *Client) readLoop(ctx context.Context, r io.Reader) {
	scanner := bufio.NewScanner(r)

	// Codex app-server can emit large JSON messages (for example long
	// reasoning traces or agent responses). The default bufio.Scanner
	// token limit (~64KB) is too small and will trigger "token too long"
	// errors, after which the scanner stops and all future RPC calls
	// will time out. Increase the maximum token size to handle large
	// envelopes safely.
	const maxTokenSize = 10 * 1024 * 1024 // 10MB
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, maxTokenSize)

	for scanner.Scan() {
		line := scanner.Bytes()

		var env rpcEnvelope
		if err := json.Unmarshal(line, &env); err != nil {
			c.logger.Printf("failed to decode message: %v (line=%s)", err, string(line))
			continue
		}

		if env.ID != nil {
			id := *env.ID

			c.mu.Lock()
			ch, ok := c.pending[id]
			if ok {
				delete(c.pending, id)
			}
			c.mu.Unlock()

			if ok {
				select {
				case ch <- append([]byte(nil), line...):
				case <-time.After(5 * time.Second):
					c.logger.Printf("dropping response for id=%d (listener slow)", id)
				}
				close(ch)
			}
		} else {
			// Notification; for now just log at a low level.
			c.broadcastNotification(line)
			c.logger.Printf("notification: %s", string(line))
		}

		select {
		case <-ctx.Done():
			return
		default:
		}
	}

	if err := scanner.Err(); err != nil {
		c.logger.Printf("scanner error: %v", err)
	}

	// Close all pending waiters on exit.
	c.mu.Lock()
	for id, ch := range c.pending {
		close(ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()

	// Close all subscribers on exit.
	c.subMu.Lock()
	for id, ch := range c.subscribers {
		close(ch)
		delete(c.subscribers, id)
	}
	c.subMu.Unlock()
}
