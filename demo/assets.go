package demo

import "embed"

// Static contains the fixed-origin Demo page assets.
//
//go:embed static/*
var Static embed.FS
