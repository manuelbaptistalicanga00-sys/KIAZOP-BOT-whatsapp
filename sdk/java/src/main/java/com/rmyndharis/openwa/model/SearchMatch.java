package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/**
 * How {@code GET /search} matches {@code q}. {@link #WORD} (the server default) matches whole words;
 * {@link #CONTAINS} matches any part of a word, ignoring case and accents, and needs at least one
 * term of 3+ characters. Wire values are lowercase.
 */
public enum SearchMatch {
    @SerializedName("word")
    WORD,
    @SerializedName("contains")
    CONTAINS
}
