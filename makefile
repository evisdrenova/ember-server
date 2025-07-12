# Makefile ────────────────────────────────────────────────────────────
# Builds and runs the Go gRPC gateway for the voice-assistant project.
#
#  make proto   – generate Go stubs from pkg/proto/*.proto (requires buf)
#  make build   – compile static binary to bin/gateway
#  make run     – run the server (builds first if necessary)
#  make tidy    – go mod tidy
#  make clean   – remove bin/
# --------------------------------------------------------------------

# --------------------------------------------------------------------
# Paths & flags
# --------------------------------------------------------------------
MODULE          := github.com/evisdrenova/ember-server
CMD_PKG         := ./cmd/server
BIN_DIR         := bin
BIN_NAME        := gateway
BIN_PATH        := $(BIN_DIR)/$(BIN_NAME)

BUF             := buf                      # or `docker run --rm ...`
PROTO_DIR       := pkg/proto

GO              := go
GOFLAGS         := -trimpath
LDFLAGS         := -s -w                   # strip debug info

# --------------------------------------------------------------------
# Tools check helpers
# --------------------------------------------------------------------
ifeq (, $(shell which buf 2>/dev/null))
  $(warning [WARN] ‘buf’ not found in PATH – ‘make proto’ will fail)
endif
ifeq (, $(shell which protoc-gen-go 2>/dev/null))
  $(warning [WARN] ‘protoc-gen-go’ not found – install with:\n\
           go install google.golang.org/protobuf/cmd/protoc-gen-go@latest)
endif
ifeq (, $(shell which protoc-gen-go-grpc 2>/dev/null))
  $(warning [WARN] ‘protoc-gen-go-grpc’ not found – install with:\n\
           go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest)
endif

# --------------------------------------------------------------------
# Targets
# --------------------------------------------------------------------
.PHONY: all proto build run tidy clean

all: build

## Generate protobuf → Go stubs (requires buf.build toolchain)
proto:
	$(BUF) generate

## Tidy dependencies
tidy:
	$(GO) mod tidy

## Build static binary (CGO disabled)
build: $(BIN_PATH)

$(BIN_PATH): tidy
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=0 $(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' \
		-o $(BIN_PATH) $(CMD_PKG)

## Run the server (auto-build if needed)
run: $(BIN_PATH)
	$(BIN_PATH)

## Clean build artifacts
clean:
	rm -rf $(BIN_DIR)
