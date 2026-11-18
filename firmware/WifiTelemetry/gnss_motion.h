#pragma once

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>

constexpr double knotsToMps = 1852.0 / 3600.0;

struct MotionField {
  double value;
  const char *status;
  bool valid() const { return std::isfinite(value); }
};

inline MotionField readMotionField(const char *field, double maximum) {
  const double missing = std::numeric_limits<double>::quiet_NaN();
  if (!*field) return {missing, "empty"};
  char *end;
  const double value = std::strtod(field, &end);
  if (end == field || *end || !std::isfinite(value) || value < 0 || value > maximum) {
    return {missing, "invalid"};
  }
  return {value, "valid"};
}

struct GnssMotion {
  MotionField speed;
  MotionField heading;
};

inline GnssMotion readGnssMotion(const char *knots, const char *course) {
  return {readMotionField(knots, std::numeric_limits<double>::max()), readMotionField(course, 360)};
}

inline bool validUtcFraction(const char *suffix) {
  if (!*suffix) return true;
  if (*suffix++ != '.' || !*suffix) return false;
  for (; *suffix; ++suffix) {
    if (*suffix < '0' || *suffix > '9') return false;
  }
  return true;
}

// A missing fractional part has only second precision. Otherwise compare the
// fractions numerically so equivalent forms such as .1 and .10 match.
inline bool sameUtcFixTime(const char *first, const char *second) {
  if (std::strlen(first) < 6 || std::strlen(second) < 6 ||
      std::strncmp(first, second, 6) != 0) return false;
  first += 6;
  second += 6;
  if (!validUtcFraction(first) || !validUtcFraction(second)) return false;
  if (!*first || !*second) return true;
  ++first;
  ++second;
  while (*first || *second) {
    const char left = *first ? *first++ : '0';
    const char right = *second ? *second++ : '0';
    if (left != right) return false;
  }
  return true;
}

struct SelectedMotion {
  double value;
  const char *source;
};

inline SelectedMotion selectMotion(MotionField gps, MotionField gnss, bool sameFix) {
  if (gps.valid()) return {gps.value, "CGPSINFO"};
  if (sameFix && gnss.valid()) return {gnss.value, "CGNSSINFO"};
  return {gps.value, nullptr};
}
