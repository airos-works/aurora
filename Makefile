# Builds aurora-host natively on Haiku against Summit's WebKit engine.
#   make                                           (the installed summit_webkit package)
#   make WEBKIT_BUNDLE=/path/to/bundle            (a bundle, headers in its include/)
#   make WEBKIT_BUNDLE=... WEBKIT_INCLUDE=...      (headers from elsewhere)
#   make ... LEGACY_ENGINE=1                       (a bundle from before 2026-09-21)

# By default the installed summit_webkit package, headers from its develop
# directory; a bundle has them in include/ (or source/include).
WEBKIT_BUNDLE ?= /boot/system/lib/summit-webkit
WEBKIT_INCLUDE ?= $(firstword $(wildcard $(WEBKIT_BUNDLE)/include $(WEBKIT_BUNDLE)/source/include) /boot/system/develop/headers/summit-webkit)
LEGACY_ENGINE ?= 0
BUILD ?= build
CXX ?= g++
CXXFLAGS ?= -O2 -g
CXXFLAGS += -std=c++20 -Wall -Wextra -Wno-multichar -Wno-unused-parameter \
	-Ihost -Ihost/vendor -I$(WEBKIT_INCLUDE) -DAURORA_LEGACY_ENGINE=$(LEGACY_ENGINE)
# Where a launcher started from Deskbar finds the engine: a bundle beside it
# (webkit/lib), or the shared install of Summit's engine, whose lib/ holds
# libWebKit and its ICU (the summit_webkit package, or the same layout
# non-packaged; a flat non-packaged directory also works).
ENGINE_RPATH ?= $$ORIGIN/webkit/lib:$$ORIGIN/webkit:/boot/system/lib/summit-webkit/lib:/boot/home/config/non-packaged/lib/summit-webkit/lib:/boot/home/config/non-packaged/lib/summit-webkit
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
