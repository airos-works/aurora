# Builds aurora-host natively on Haiku against a Summit WebKit bundle.
#   make WEBKIT_BUNDLE=/path/to/bundle            (headers from the bundle's source/include)
#   make WEBKIT_BUNDLE=... WEBKIT_INCLUDE=...      (headers from elsewhere)
#   make ... LEGACY_ENGINE=1                       (a bundle from before 2026-09-21)

WEBKIT_BUNDLE ?= /boot/home/summit/build-modern-browser/current
WEBKIT_INCLUDE ?= $(WEBKIT_BUNDLE)/source/include
LEGACY_ENGINE ?= 0
BUILD ?= build
CXX ?= g++
CXXFLAGS ?= -O2 -g
CXXFLAGS += -std=c++20 -Wall -Wextra -Wno-multichar -Wno-unused-parameter \
	-Ihost -Ihost/vendor -I$(WEBKIT_INCLUDE) -DAURORA_LEGACY_ENGINE=$(LEGACY_ENGINE)
# Where a launcher started from Deskbar finds the engine: beside it, or in a
# shared install of Summit's engine.
ENGINE_RPATH ?= $$ORIGIN/webkit/lib:/boot/system/data/summit/webkit/lib:/boot/home/config/non-packaged/data/summit/webkit/lib
LIBS = -L$(WEBKIT_BUNDLE)/lib -lWebKit -lbe -ltracker -Wl,-rpath,'$(ENGINE_RPATH)'


SOURCES = $(wildcard host/*.cpp)
OBJECTS = $(SOURCES:host/%.cpp=$(BUILD)/%.o)

all: $(BUILD)/aurora-host

$(BUILD)/%.o: host/%.cpp host/*.h
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/aurora-host: $(OBJECTS) host/aurora-host.rdef
	$(CXX) -o $@ $(OBJECTS) $(LIBS)
	rc -o $(BUILD)/aurora-host.rsrc host/aurora-host.rdef
	xres -o $@ $(BUILD)/aurora-host.rsrc
	mimeset -f $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
