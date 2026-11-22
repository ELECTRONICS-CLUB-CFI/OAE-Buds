#pragma once

#include <iostream>
#include <vector>
#include <string>
#include <functional>
#include <cmath>
#include <sstream>

namespace mini_gtest {

struct TestFailure {
    std::string file;
    int line;
    std::string message;
};

class TestCase {
public:
    std::string suite_name;
    std::string test_name;
    std::function<void()> test_func;
    std::vector<TestFailure> failures;

    TestCase(std::string s, std::string t, std::function<void()> f)
        : suite_name(std::move(s)), test_name(std::move(t)), test_func(std::move(f)) {}
};

class TestRegistry {
public:
    static TestRegistry& instance() {
        static TestRegistry reg;
        return reg;
    }

    void register_test(const std::string& suite, const std::string& name, std::function<void()> func) {
        tests_.emplace_back(suite, name, std::move(func));
    }

    TestCase* current_test() { return current_test_; }

    int run_all() {
        int passed = 0;
        int failed = 0;
        std::cout << "[==========] Running " << tests_.size() << " test(s).\n";

        for (auto& t : tests_) {
            current_test_ = &t;
            std::cout << "[ RUN      ] " << t.suite_name << "." << t.test_name << "\n";
            try {
                t.test_func();
            } catch (const std::exception& e) {
                t.failures.push_back({__FILE__, __LINE__, std::string("Unhandled exception: ") + e.what()});
            } catch (...) {
                t.failures.push_back({__FILE__, __LINE__, "Unhandled unknown exception"});
            }

            if (t.failures.empty()) {
                std::cout << "[       OK ] " << t.suite_name << "." << t.test_name << "\n";
                passed++;
            } else {
                std::cout << "[  FAILED  ] " << t.suite_name << "." << t.test_name << "\n";
                for (const auto& f : t.failures) {
                    std::cout << "  " << f.file << ":" << f.line << ": " << f.message << "\n";
                }
                failed++;
            }
        }

        std::cout << "[==========] " << tests_.size() << " test(s) run.\n";
        std::cout << "[  PASSED  ] " << passed << " test(s).\n";
        if (failed > 0) {
            std::cout << "[  FAILED  ] " << failed << " test(s).\n";
            return 1;
        }
        return 0;
    }

private:
    std::vector<TestCase> tests_;
    TestCase* current_test_ = nullptr;
};

struct TestRegistrar {
    TestRegistrar(const std::string& s, const std::string& t, std::function<void()> f) {
        TestRegistry::instance().register_test(s, t, std::move(f));
    }
};

} // namespace mini_gtest

#define TEST(suite_name, test_name) \
    void _test_func_##suite_name##_##test_name(); \
    static ::mini_gtest::TestRegistrar _test_reg_##suite_name##_##test_name( \
        #suite_name, #test_name, _test_func_##suite_name##_##test_name); \
    void _test_func_##suite_name##_##test_name()

#define EXPECT_TRUE(cond) \
    do { \
        if (!(cond)) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                cur->failures.push_back({__FILE__, __LINE__, "Expected: (" #cond ") is true"}); \
            } \
        } \
    } while(0)

#define EXPECT_FALSE(cond) \
    do { \
        if (cond) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                cur->failures.push_back({__FILE__, __LINE__, "Expected: (" #cond ") is false"}); \
            } \
        } \
    } while(0)

#define EXPECT_EQ(val1, val2) \
    do { \
        if (!((val1) == (val2))) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "Expected equality of (" #val1 ") and (" #val2 "): " << (val1) << " vs " << (val2); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
        } \
    } while(0)

#define EXPECT_NE(val1, val2) \
    do { \
        if ((val1) == (val2)) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "Expected inequality of (" #val1 ") and (" #val2 "): both are " << (val1); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
        } \
    } while(0)

#define EXPECT_NEAR(val1, val2, abs_error) \
    do { \
        double diff = std::abs(static_cast<double>(val1) - static_cast<double>(val2)); \
        if (diff > static_cast<double>(abs_error)) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "The difference between (" #val1 ") and (" #val2 ") is " << diff \
                   << ", which exceeds " #abs_error " (" << abs_error << "). Actual: " << (val1) << " vs " << (val2); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
        } \
    } while(0)

#define EXPECT_LE(val1, val2) \
    do { \
        if (!((val1) <= (val2))) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "Expected (" #val1 ") <= (" #val2 "): " << (val1) << " vs " << (val2); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
        } \
    } while(0)

#define EXPECT_GE(val1, val2) \
    do { \
        if (!((val1) >= (val2))) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "Expected (" #val1 ") >= (" #val2 "): " << (val1) << " vs " << (val2); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
        } \
    } while(0)

#define EXPECT_LT(val1, val2) \
    do { \
        if (!((val1) < (val2))) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "Expected (" #val1 ") < (" #val2 "): " << (val1) << " vs " << (val2); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
        } \
    } while(0)

#define EXPECT_GT(val1, val2) \
    do { \
        if (!((val1) > (val2))) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "Expected (" #val1 ") > (" #val2 "): " << (val1) << " vs " << (val2); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
        } \
    } while(0)

#define ASSERT_TRUE(cond) \
    do { \
        if (!(cond)) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                cur->failures.push_back({__FILE__, __LINE__, "Fatal: (" #cond ") is false"}); \
            } \
            return; \
        } \
    } while(0)

#define ASSERT_FALSE(cond) \
    do { \
        if (cond) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                cur->failures.push_back({__FILE__, __LINE__, "Fatal: (" #cond ") is true"}); \
            } \
            return; \
        } \
    } while(0)

#define ASSERT_EQ(val1, val2) \
    do { \
        if (!((val1) == (val2))) { \
            if (auto* cur = ::mini_gtest::TestRegistry::instance().current_test()) { \
                std::ostringstream ss; \
                ss << "Fatal: (" #val1 ") != (" #val2 "): " << (val1) << " vs " << (val2); \
                cur->failures.push_back({__FILE__, __LINE__, ss.str()}); \
            } \
            return; \
        } \
    } while(0)

inline int RUN_ALL_TESTS() {
    return ::mini_gtest::TestRegistry::instance().run_all();
}
